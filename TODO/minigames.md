#### Roulette (!roulette <částka/all>)

• Princip: Jednoduchá sázka typu „všechno, nebo nic“ (hod mincí).
• Pravidla: Divák vsadí určitý počet bodů (nebo all pro všechny body). Bot náhodně určí výsledek (výchozí šance bývá kolem 40–50 %). Při výhře divák získá dvojnásobek sázky, při prohře o vsazené body přichází.

#### Gamble (!gamble <částka>)

• Princip: Hod kostkou nebo generování náhodného čísla (obvykle 1–100).
• Pravidla: Podle toho, jaké číslo padne, se určuje výsledek:
• 1–60: Prohra (divák ztrácí vsazené body).
• 61–98: Výhra (divák vyhrává dvojnásobek sázky).
• 99–100: Jackpot (divák vyhrává trojnásobek sázky).

#### Slots (!slots <částka>)

• Princip: Klasický výherní automat se třemi symboly (emotikony) v chatu.
• Pravidla: Divák vsadí body a bot vygeneruje 3 náhodné emotikony (např. 🍒 🍋 💎).
• 3 stejné symboly: Hlavní výhra (násobek sázky se liší podle vzácnosti symbolu).
• 2 stejné symboly: Malá výhra nebo vrácení vkladu (záleží na nastavení bota).
• 3 různé symboly: Prohra.

#### Duel (!duel <uživatel> <částka>)

• Princip: Souboj 1 na 1 mezi dvěma diváky v chatu.
• Pravidla: Jeden divák vyzve druhého a určí výši sázky. Vyzvaný hráč musí souboj přijmout příkazem (např. !accept). Bot následně náhodně vybere vítěze (šance 50/50), který bere celý bank (sázky obou hráčů).

#### Heist / Loupež (!heist <částka>)

• Princip: Společná kooperativní minihra pro celý chat (typická pro Streamlabs).
• Pravidla: Jeden divák zahájí loupež a ostatní mají omezený čas (např. 60 sekund), aby se přidali se svou sázkou. Po vypršení času bot simuluje průběh akce. Čím více lidí se zapojí, tím těžší cíl vyloupí a tím vyšší je násobitel výhry pro přeživší hráče.

#### Emote Bingo (!bingo)

• Princip: Postřehová hra s emotikony bez nutnosti sázet body (typická pro StreamElements).
• Pravidla: Moderátor nebo streamer spustí hru, při které bot vybere jeden tajný emotikon z dostupné sady. Diváci se ho snaží uhodnout psaním do chatu. První divák, který napíše správný emotikon, vyhrává předem nastavenou bodovou odměnu.

#### Emote Pyramid & Emote Combo

• Princip: Komunitní výzvy na spolupráci celého chatu.
• Pravidla:
• Combo: Pokud několik diváků po sobě pošle stejný emotikon bez přerušení jiným textem, bot odmění všechny zúčastněné body.
• Pyramida: Divák musí postupně vystavět a zase zbourat pyramidu ze stejného emotikonu (1 -> 2 -> 3 -> 2 -> 1) v po sobě jdoucích zprávách, aniž by mu do toho kdokoli jiný v chatu napsal.

#### Trivia / Kvíz (!trivia)

• Princip: Vědomostní soutěž v chatu (např. ve Wizebotu nebo vlastních skriptech).
• Pravidla: Bot položí otázku v chatu a spustí odpočet. První divák, který napíše správnou odpověď (nebo správné písmeno možnosti), získává body.

Zde je 10 dalších nápadů na chatové minihry (včetně jejich pravidel), které skvěle fungují pro zapojení publika a dají se snadno nastavit přes vlastní příkazy nebo skripty:

#### Ruská ruleta (!russian)

• Princip: Skupinová vyřazovací hra o přežití (a proti timeoutu).
• Pravidla: Do hry se přihlásí několik hráčů se stejným vkladem. Bot má „revolver“ s 6 komorami a jedním nábojem. Postupně „střílí“ na jednotlivé hráče. Kdo schytá ránu, prohrává sázku (a může dostat i krátký timeout, např. 10 sekund). Přeživší si mezi sebou rozdělí bank vyřazených.

#### Lovec pokladů / Kopání (!dig / !fish)

• Princip: Sběratelská hra založená na náhodě (simulace rybaření nebo těžby).
• Pravidla: Divák zaplatí malý poplatek za „vybavení“ a použije příkaz. Bot vylosuje úlovek podle vzácnosti: bezcenný odpad (0 bodů), běžný úlovek (vrácení vkladu), vzácný předmět (trojnásobek) nebo legendární poklad (desetinásobek + speciální hláška v chatu).

#### Šibenice (!hangman <písmeno/slovo>)

• Princip: Klasické hádání tajného slova celým chatem.
• Pravidla: Bot napíše do chatu zakryté slovo (např. \_ \_ \_ \_ \_) a počet zbývajících životů. Diváci píšou jednotlivá písmena. Každé chybné písmeno ubere život. Kdo uhodne poslední písmeno nebo napíše celé správné slovo dřív, než dojdou životy, bere odměnu.

#### Horký brambor (!pass <uživatel>)

• Princip: Rychlá předávací hra na čas.
• Pravidla: Bot náhodně hodí jednomu aktivnímu divákovi v chatu „tikající bombu“ (nebo horký brambor) s náhodným odpočtem (např. 15–45 sekund). Hráč ji musí rychle přehodit na jiného aktivního diváka. U koho bomba vybuchne, ztrácí určitý počet bodů (které se přičtou tomu, kdo mu ji hodil).

#### Kámen, nůžky, papír (!rps <volba> <částka>)

• Princip: Klasický souboj proti botovi (nebo jinému divákovi).
• Pravidla: Divák vsadí body a vybere si kámen, nůžky nebo papír. Bot náhodně vybere svůj tah. Výhra znamená dvojnásobek sázky, remíza vrácení vkladu a prohra ztrátu bodů.

#### Boss Raid (!attack)

• Princip: Společný souboj celého chatu proti virtuálnímu monstru s určitým počtem životů (HP).
• Pravidla: Streamer nebo bot vyvolá bosse (např. 1 000 HP) na 2 minuty. Diváci útočí příkazem (každý útok udělí náhodné poškození, např. 10–50 HP, s krátkým cooldownem). Pokud chat bosse porazí včas, všichni útočníci získají odměnu; hráč s největším poškozením dostane bonus navíc.

#### Vyšší nebo nižší (!high / !low)

• Princip: Karetní nebo číselná tipovačka s postupným násobením výhry.
• Pravidla: Bot vylosuje první číslo od 1 do 100 (např. 35) a hráč vsadí body na to, zda další číslo bude vyšší, nebo nižší. Pokud uhodne, může si vybrat výhru, nebo pokračovat dál s vyšším násobitelem (při první chybě ale ztrácí vše).

#### Přetahovaná lanem (!pull)

• Princip: Týmová bitva dvou stran chatu (např. tým Červení vs. tým Modří).
• Pravidla: Lano začíná na pozici 0. Diváci se rozdělí do dvou týmů a spamují příkaz (s cooldownem např. 5 sekund), čímž posouvají lano o 1 bod na svou stranu. Vyhrává tým, který jako první přetáhne lano na hodnotu +10 nebo -10.

#### Dostihy / Závody (!bet <číslo 1-4> <částka>)

• Princip: Sázení na virtuální závod čtyř účastníků (např. emotikonů nebo zvířat).
• Pravidla: Diváci si vyberou svého favorita a vsadí body. Bot pak v několika zprávách simuluje průběh závodu (náhodně posouvá jednotlivé závodníky vpřed). Kdo vsadil na vítěze, získává trojnásobek sázky.

#### Rychlé prsty (!type)

• Princip: Závod v rychlosti a přesnosti psaní.
• Pravidla: Bot pošle do chatu náhodný kód nebo složitější slovo (např. X7k-92P-mQ). První divák, který kód napíše do chatu bez jediné chyby (včetně velkých a malých písmen), okamžitě vyhrává balík bodů.
