# CrateScope

Analyseur de bibliothèque musicale façon Rekordbox (Electron + ffmpeg) : BPM, tonalité (Camelot), waveform 3 bandes, loudness (LUFS), énergie, plus genre / style / label / année récupérés en ligne.

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
- Plage de BPM réglable (88–180 par défaut) : les tempos sont ramenés dans cette plage.

## Utilisation

- Clic = charger dans le deck (lecture continue si déjà en lecture), double-clic / Entrée = lire, clic sur une mini-waveform = lire depuis ce point.
- Espace lecture/pause, ↑/↓ titre suivant/précédent, ←/→ avance de 8 s (Maj : 30 s), molette sur la waveform = zoom, glisser = scratch.
- **Mixables** (touche `m`) : n'affiche que les titres compatibles harmoniquement avec le titre chargé (Camelot ±1 / relatif) et à ±6 % de BPM (ou demi/double tempo).
- Glisser des lignes vers Rekordbox, Ableton, le Finder… ; clic droit : Finder, ré-analyse, re-recherche en ligne, Discogs/MusicBrainz.
- Export de la vue (ou de la sélection) en playlist M3U8 ou en CSV.
- BPM à moitié ou doublé ? Boutons **÷2 / ×2** à côté du BPM dans le deck, touches `/` et `*` (sur la sélection), ou clic droit. La correction est gardée même après une ré-analyse ; le BPM corrigé s'affiche en bleu.
- Un `*` à côté du BPM signale un désaccord avec le tag BPM du fichier.

## Mesurer la précision

`npm run eval -- <dossier>` compare l'analyse aux tags BPM/tonalité déjà présents dans les fichiers.

## Construire l'app macOS

```bash
npm run package       # → dist/CrateScope-darwin-arm64/CrateScope.app (signature ad-hoc)
npm run install_app   # package + copie dans /Applications
```

L'icône est générée depuis `build/icon.svg` (→ `icon.png` → `icon.icns`).
