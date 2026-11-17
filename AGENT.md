do not use subagents

encoder: ssh pi@192.168.10.104
relay: ssh user@192.168.1.211
test server: ssh vondracek.dev
Never ever change networking on test server!!

This is how to update ctrlirtl on relay and encoder:

bun run build:client && scp ./dist/client-arm pi@192.168.10.104:/home/pi && scp ./dist/client-arm user@192.168.1.211:/home/user

run:
This is how to update ctrlirtl on relay and encoder:

directories:
encoder: /home/pi
relay: /home/user

./client-arm --host 0.0.0.0

relay / enable routing:
sudo sysctl -w net.ipv4.ip_forward=1
sudo iptables -t nat -A POSTROUTING -o eth0 -j MASQUERADE
sudo iptables -A FORWARD -i eth1 -o eth0 -j ACCEPT
sudo iptables -A FORWARD -i eth0 -o eth1 -m conntrack --ctstate RELATED,ESTABLISHED -j ACCEPT
