# 🎹 MIDIfieur

Transforme n'importe quel fichier audio (MP3, WAV, OGG…) en `.mid`, directement dans le navigateur, avec l'IA Basic Pitch de Spotify. Aucun serveur n'est nécessaire.

## Mettre en ligne
Le dossier `public/` est un site statique prêt à l'emploi :
- **Vercel** : `vercel deploy public --prod` (ou tu glisses le dossier sur vercel.com/new)
- **En local** : `cd public && python3 -m http.server 8000`, puis tu ouvres http://localhost:8000

⚠️ Il faut passer par un serveur, pas par un double-clic sur index.html, parce que le modèle se charge via `fetch`.

## Modifier le code
```
npm install
npx esbuild src/main.js --bundle --minify --format=iife --target=es2019 --outfile=public/app.js
cp -r node_modules/@spotify/basic-pitch/model public/
```

## Précision
Sur un test (gamme, accord de 4 notes, arpège), il a trouvé 16 notes sur 16, avec un décalage de moins de 15 ms.
Pour un morceau complet, sépare d'abord les pistes (par exemple avec Demucs), puis passe chaque piste dans le site.
