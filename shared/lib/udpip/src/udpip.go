// udpip — a plain UDP ↔ TUN IP-packet pump (no auth, no crypto).
//
// It is the functional equivalent of a kernel IPIP-over-UDP (FOU) tunnel for
// hosts whose vendor kernels cannot load `fou.ko`: an L3 IP tunnel carried as
// UDP datagrams in userspace. Two copies run, one per endpoint of the trusted
// dedicated link:
//
//	udpip server --tun utn-eth0 --bind <uplinkIP>:<port> [--allow <clientIP>|first]
//	udpip client --tun utn-eth0 --remote <uplinkIP>:<port>
//
// The process owns the TUN netdev: it opens /dev/net/tun and runs TUNSETIFF to
// CREATE + hold the data-path file descriptor (a TUN/TAP data path is only
// accessible to the process that created it). It does NOT run `ip` — the
// supervising app addresses the netdev (`ip addr add …` / `link set mtu` /
// `link set up`) by name once the device appears. UDP datagrams are IP
// packets (no extra encapsulation header), so the netdev is addressed over a
// /30 and policy-routing is identical to a real interface.
//
// Server pinning: the server pins a single peer. With `--allow <ip>` only
// datagrams from that IP are accepted; with the default `--allow first` the
// first datagram's source becomes the peer and all others are dropped. This
// is the only protection on this trustless-by-design link (the user decision
// to skip auth/crypto applies to the trusted relay↔encoder segment).
package main

import (
	"flag"
	"fmt"
	"log"
	"net"
	"os"
	"os/signal"
	"sync"
	"syscall"
	"time"
	"unsafe"

	"golang.org/x/sys/unix"
)

// bufSize: room for a full Ethernet-frame MTU plus headroom. IP packets on a
// 1400-MTU TUN never exceed this.
const bufSize = 65536

type options struct {
	mode   string // "server" or "client"
	tun    string
	bind   string // server: <uplinkIP>:<port>
	remote string // client: <uplinkIP>:<port>
	allow  string // server: <clientIP> or "first"
}

// ifrTun is the TUNSETIFF payload: 16-byte device name (NUL-padded) + flags.
type ifrTun struct {
	ifname [16]byte
	flags  uint16
}

// openTUN opens /dev/net/tun and creates (TUNSETIFF) the netdev `name`,
// returning the blocking data-path fd. Only this process may read/write it.
func openTUN(name string) (int, error) {
	fd, err := unix.Open("/dev/net/tun", os.O_RDWR, 0)
	if err != nil {
		return -1, fmt.Errorf("open /dev/net/tun: %w", err)
	}
	if len(name) > 15 {
		unix.Close(fd)
		return -1, fmt.Errorf("tun name %q too long (max 15)", name)
	}
	var ifr ifrTun
	copy(ifr.ifname[:], name)
	ifr.flags = unix.IFF_TUN | unix.IFF_NO_PI // no per-packet info prefix
	if _, _, errno := unix.Syscall(
		unix.SYS_IOCTL, uintptr(fd), unix.TUNSETIFF,
		uintptr(unsafe.Pointer(&ifr)),
	); errno != 0 {
		unix.Close(fd)
		return -1, fmt.Errorf("TUNSETIFF %q: %w", name, errno)
	}
	return fd, nil
}

// runServer: bind <bind>, pin one peer, pump UDP↔TUN in both directions.
func runServer(o options, tunFd int) error {
	addr, err := net.ResolveUDPAddr("udp4", o.bind)
	if err != nil {
		return fmt.Errorf("resolve bind %q: %w", o.bind, err)
	}
	conn, err := net.ListenUDP("udp4", addr)
	if err != nil {
		return fmt.Errorf("bind udp %q: %w", o.bind, err)
	}
	conn.SetReadBuffer(8 << 20)
	log.Printf("udpip server: tun=%s bound=%s allow=%s pid=%d", o.tun, o.bind, o.allow, os.Getpid())

	if o.allow != "first" {
		if _, _, err := net.ParseCIDR(o.allow); err != nil {
			// Accept a bare IP by normalising to /32.
			if ip := net.ParseIP(o.allow); ip == nil {
				return fmt.Errorf("bad --allow %q (want IP or 'first')", o.allow)
			}
		}
	}

	var (
		mu       sync.Mutex
		peer     *net.UDPAddr
	)
	allowed := func(src *net.UDPAddr) bool {
		if o.allow == "first" {
			return true
		}
		return src.String() == o.allow
	}

	// udp→tun: pin the peer (first/allowed source) then write to the TUN.
	udpToTun := func() {
		buf := make([]byte, bufSize)
		for {
			n, src, err := conn.ReadFromUDP(buf)
			if err != nil {
				if ne, ok := err.(net.Error); ok && ne.Timeout() {
					continue
				}
				log.Printf("udpip: udp read: %v", err)
				return
			}
			if !allowed(src) {
				continue
			}
			mu.Lock()
			if peer == nil {
				peer = src
				log.Printf("udpip: pinned peer %s", src)
			}
			pinned := peer
			mu.Unlock()
			if src.String() != pinned.String() {
				continue // a second, different source — drop (single peer)
			}
			if n == 0 {
				continue
			}
			if _, werr := unix.Write(tunFd, buf[:n]); werr != nil {
				log.Printf("udpip: tun write: %v", werr)
				return
			}
		}
	}

	// tun→udp: read IP packets from the TUN, send to the pinned peer.
	tunToUdp := func() {
		buf := make([]byte, bufSize)
		for {
			n, err := unix.Read(tunFd, buf)
			if err != nil {
				if err == syscall.EINTR || err == syscall.EAGAIN {
					continue
				}
				log.Printf("udpip: tun read: %v", err)
				return
			}
			if n == 0 {
				continue
			}
			// Wait for the peer to be pinned before sending (the client
			// always dials first, so this is bounded in practice).
			mu.Lock()
			pinned := peer
			mu.Unlock()
			for pinned == nil {
				time.Sleep(10 * time.Millisecond)
				mu.Lock()
				pinned = peer
				mu.Unlock()
			}
			if _, werr := conn.WriteToUDP(buf[:n], pinned); werr != nil {
				log.Printf("udpip: udp write: %v", werr)
				return
			}
		}
	}

	return runPump(conn, func() { go udpToTun(); tunToUdp() })
}

// runClient: dial <remote>, pump UDP↔TUN in both directions.
func runClient(o options, tunFd int) error {
	remote, err := net.ResolveUDPAddr("udp4", o.remote)
	if err != nil {
		return fmt.Errorf("resolve remote %q: %w", o.remote, err)
	}
	conn, err := net.DialUDP("udp4", nil, remote)
	if err != nil {
		return fmt.Errorf("dial udp %q: %w", o.remote, err)
	}
	conn.SetReadBuffer(8 << 20)
	log.Printf("udpip client: tun=%s remote=%s pid=%d", o.tun, o.remote, os.Getpid())

	udpToTun := func() {
		buf := make([]byte, bufSize)
		for {
			n, err := conn.Read(buf)
			if err != nil {
				log.Printf("udpip: udp read: %v", err)
				return
			}
			if n == 0 {
				continue
			}
			if _, werr := unix.Write(tunFd, buf[:n]); werr != nil {
				log.Printf("udpip: tun write: %v", werr)
				return
			}
		}
	}
	tunToUdp := func() {
		buf := make([]byte, bufSize)
		for {
			n, err := unix.Read(tunFd, buf)
			if err != nil {
				if err == syscall.EINTR || err == syscall.EAGAIN {
					continue
				}
				log.Printf("udpip: tun read: %v", err)
				return
			}
			if n == 0 {
				continue
			}
			if _, werr := conn.Write(buf[:n]); werr != nil {
				log.Printf("udpip: udp write: %v", werr)
				return
			}
		}
	}

	return runPump(conn, func() { go udpToTun(); tunToUdp() })
}

// runPump runs `start` (which blocks) until a SIGTERM/SIGINT arrives, then
// closes the UDP conn (unblocking the pumps) and exits 0.
func runPump(conn *net.UDPConn, start func()) error {
	sig := make(chan os.Signal, 1)
	signal.Notify(sig, syscall.SIGTERM, syscall.SIGINT)
	start()
	<-sig
	log.Printf("udpip: shutting down (pid=%d)", os.Getpid())
	conn.Close()
	return nil
}

func main() {
	log.SetOutput(os.Stderr)
	log.SetFlags(log.LstdFlags | log.Lmicroseconds)

	var o options
	flag.StringVar(&o.mode, "mode", "", "server | client (positional arg also accepted)")
	flag.StringVar(&o.tun, "tun", "", "TUN netdev name to create/own (e.g. utn-eth0)")
	flag.StringVar(&o.bind, "bind", "", "server bind address <uplinkIP>:<port>")
	flag.StringVar(&o.remote, "remote", "", "client remote <uplinkIP>:<port>")
	flag.StringVar(&o.allow, "allow", "first", "server peer pin: a client IP, or 'first'")
	flag.Parse()

	// Accept the mode as a positional leading arg too: `udpip server …`.
	if o.mode == "" && flag.NArg() > 0 {
		o.mode = flag.Arg(0)
	}

	if o.tun == "" {
		fatalf("missing --tun <name>")
	}
	switch o.mode {
	case "server":
		if o.bind == "" {
			fatalf("server requires --bind <uplinkIP>:<port>")
		}
	case "client":
		if o.remote == "" {
			fatalf("client requires --remote <uplinkIP>:<port>")
		}
	default:
		fatalf("unknown mode %q (want server|client)", o.mode)
	}

	fd, err := openTUN(o.tun)
	if err != nil {
		// A leftover netdev with our name means a stale peer is still
		// holding it; surface it so the supervisor tears it down and retries.
		fatalf("%v", err)
	}
	defer unix.Close(fd)

	if err := openTUNGuard(o.mode, o, fd); err != nil {
		fatalf("%v", err)
	}
}

// openTUNGuard dispatches to the right pump. Split out so main() stays short.
func openTUNGuard(mode string, o options, tunFd int) error {
	switch mode {
	case "server":
		return runServer(o, tunFd)
	case "client":
		return runClient(o, tunFd)
	default:
		return fmt.Errorf("unknown mode %q", mode)
	}
}

func fatalf(format string, a ...any) {
	log.Fatalf(format, a...)
}
