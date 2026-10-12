#!/usr/bin/env bash
cd "$(dirname "$0")" || exit 1
command -v node >/dev/null || { echo "Node.js is not installed. Get it from https://nodejs.org"; exit 1; }
[ -d node_modules ] || npm install || exit 1
echo
echo "Subtitle Translator is starting. Open http://localhost:3000 in your browser."
echo "Press Ctrl+C to stop."
echo
node server.js
