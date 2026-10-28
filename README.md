# CrateScope

Analyseur de bibliothèque musicale façon Rekordbox (Electron + ffmpeg) : BPM, tonalité (Camelot), waveform 3 bandes, loudness (LUFS), plus genre / style / label / année récupérés en ligne.

## Lancer

Prérequis : Node 18+ et `ffmpeg` / `ffprobe` dans le PATH (`brew install ffmpeg`).

```bash
npm install
npm start                      # rouvre le dernier dossier
npm start -- ~/Music/Crate     # ouvre directement un dossier
```

## Fonctionnement

- **Scan** récursif du dossier (mp3, wav, flac, aiff, ogg, opus, m4a, wma, ape…), surveillé en direct (ajouts/suppressions).
- **Analyse** en arrière-plan dans un pool de worker threads : un seul passage ffmpeg décode en mono 11 kHz *et* mesure le loudness EBU R128. Le DSP (JS pur, `src/analysis/dsp.js`) calcule :
  - BPM : enveloppe d'onsets multi-bandes → autocorrélation → vérification des niveaux métriques (×2, ×3/2, ×4/3…) par peigne aligné en phase → affinage au 1/100 de BPM + grille de temps ;
  - tonalité : chromagramme blanchi, accent sur la basse, profils de Sha'ath (libKeyFinder) → notation Camelot ;
  - waveforms (mini, vue d'ensemble, détaillée à 50 points/s) en 3 bandes.
  Le dossier en cours d'affichage est analysé en priorité. Résultats en cache (`~/Library/Application Support/cratescope`), donc les réouvertures sont instantanées.
- **Métadonnées en ligne** : MusicBrainz (sans clé) et Discogs (token perso gratuit, donne genre **et** style, label, pochette). À configurer dans ⚙︎.
- Plage de BPM réglable (88–180 par défaut) : les tempos sont ramenés dans cette plage. Avec une plage large (ex. 80–220), entre un tempo et son double c'est le plus proche de ~140 BPM qui l'emporte, sauf si l'autre est nettement plus marqué.

## Utilisation

- Clic = charger dans le deck (lecture continue si déjà en lecture), double-clic / Entrée = lire, clic sur une mini-waveform = lire depuis ce point.
- Espace lecture/pause, ↑/↓ titre suivant/précédent, ←/→ avance de 8 s (Maj : 30 s), molette sur la waveform = zoom, glisser = scratch.
- **Mixables** (touche `m`) : n'affiche que les titres compatibles harmoniquement avec le titre chargé (Camelot ±1 / relatif) et à ±6 % de BPM (ou demi/double tempo).
- Glisser des lignes vers Rekordbox, Ableton, le Finder… ; clic droit : Finder, ré-analyse, re-recherche en ligne, Discogs/MusicBrainz.
- Export de la vue (ou de la sélection) en playlist M3U8 ou en CSV.
- **Grille** : le BPM est affiné par suivi des temps et régression sur tout le morceau (précision ~5 ms), le 1er temps des mesures est déduit des changements de section, les drops / breaks sont repérés (marqueurs DROP / BREAK, ligne jaune toutes les 16 mesures à partir du drop). Un avertissement s'affiche si le tempo varie (vinyle, live) ou si le 1er temps est incertain.
- **Corriger la grille** (barre « Grille » du deck) : `⇤ 1` / `1 ⇥` décalent le 1er temps de la mesure d'un temps (`[` `]`), `‹` `›` décalent la grille de 5 ms (Alt : 1 ms, touches `,` `.`), « 1 ici » fait du temps le plus proche de la tête de lecture un 1er temps (`G`), « Caler ici » cale la grille exactement sur la tête de lecture (`⇧G`), « Auto » revient à la détection. « ♩ Clic » (`C`) joue un métronome sur la grille pour vérifier à l'oreille.
- **BPM manuel** : clique sur le BPM du deck pour le saisir. La grille pivote autour du drop principal, là où elle compte le plus.
- BPM à moitié ou doublé ? Boutons **÷2 / ×2** à côté du BPM dans le deck, touches `/` et `*` (sur la sélection), ou clic droit. La correction est gardée même après une ré-analyse ; le BPM corrigé s'affiche en bleu.
- Un `*` à côté du BPM signale un désaccord avec le tag BPM du fichier.

## Mesurer la précision

`npm run eval -- <dossier>` compare l'analyse aux tags BPM/tonalité déjà présents dans les fichiers et mesure la stabilité de la grille. `node scripts/grid-test.js` vérifie BPM, grille, 1er temps et drop sur des morceaux synthétiques dont on connaît la vérité.

## Builds et releases

```bash
npm run package        # macOS Apple Silicon → dist/CrateScope-<version>-macos-arm64.zip
npm run package:mac-x64
npm run package:win    # Windows x64 (se construit aussi depuis macOS/Linux) → dist/CrateScope-<version>-windows-x64.zip
npm run install_app    # build Apple Silicon + copie dans /Applications
```

ffmpeg/ffprobe sont embarqués dans les builds (`scripts/fetch-ffmpeg.sh` → `vendor/`, copiés dans `resources/ffmpeg`). En dev, l'app utilise ffmpeg du PATH / Homebrew.

Chaque push sur `main` déclenche `.github/workflows/release.yml` : builds macOS (arm64 + x64) et Windows, vérification de ffmpeg et de l'analyse sur les binaires embarqués (`scripts/ci-check.js`, y compris sur un runner Windows), puis publication d'une release GitHub `v<version>-build.<n>` avec les trois zips, nommés `CrateScope-<version>-build.<n>-<système>-<arch>.zip`.

Les icônes sont générées depuis `build/icon.svg` (→ `icon.png` → `icon.icns`, et `node scripts/make-ico.js` pour `icon.ico`).
