# Tulostaulu

Selainpohjainen urheilun tulostaulu, suunniteltu erityisesti salibandyn ajanottoon ja tulosten näyttämiseen. Sovellus toimii kahdessa välilehdessä: operaattori hallitsee peliä ja erillinen tulostaulu-näyttö näyttää tiedot yleisölle.

## Ominaisuudet

### Kaksi näkymää
- **Ohjausnäkymä** — pelikello, maalien kirjaus, jäähyt, aikalisät ja asetukset
- **Tulostaulunäkymä** (`?role=display`) — suuri mustapohjaiseen näyttöön tarkoitettu esitysnäkymä

### Pelikello
- Säädettävä eräpituus (1–60 min)
- Kellon manuaalinen säätö ±1 s kellon ollessa pysähdyksissä
- Summeri erän päättyessä

### Maalien kirjaus
- +1 / −1 napit kotijoukkueelle ja vierasjoukkueelle
- Pisteet päivittyvät tulostaululle vasta kellon käynnistyessä (mahdollistaa korjaukset ennen näyttöä)

### Erät ja tauot
- Erät 1–3 (+ jatkoaika)
- Automaattinen erätauko-dialogi erän päättyessä
- Säädettävä erätauon pituus

### Jatkoaika
- Käytössä/pois checkbox-asetuksella
- Säädettävä jatkoajan pituus ja tauon pituus
- Aktivoituu automaattisesti 3. erän jälkeen tasatilanteessa
- Jos 3. erän jälkeen tilanne ei ole tasan, peli päättyy

### Jäähyt
- Enintään 2 samanaikaista jäähyä per joukkue (2:00)
- Jäähyajastimet vähenevät kellon käydessä

### Aikalisät
- 30 sekunnin aikalisä, yksi per joukkue per erä
- Käytettävissä vain kellon ollessa pysähdyksissä

### Muut
- Välilehtien synkronointi (BroadcastChannel + localStorage-varajärjestelmä)
- Tilan tallennus localStorageen (kestää sivun uudelleenlatauksen)
- Joukkueiden nimet muokattavissa (max 24 merkkiä)
- Summerin äänenvoimakkuuden säätö
- "Uusi ottelu" -toiminto nollauksella

## Käynnistys

```bash
npm install
npm start
```

Avaa ohjausnäkymä osoitteessa [http://localhost:3000](http://localhost:3000). Tulostaulu-näyttö avataan ohjausnäkymän "Avaa tulostaulu" -napista.

## Tuotantoversio

```bash
npm run build
```

Rakentaa optimoidun version `build/`-kansioon. JavaScript-tiedostot obfuskoidaan automaattisesti.

## Testit

```bash
npm test
```

## Teknologia

- React 19
- Ei ulkoisia UI-kirjastoja — inline-tyylitys
- `useReducer` tilanhallintaan
- `BroadcastChannel` välilehtien synkronointiin
