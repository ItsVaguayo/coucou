#!/usr/bin/env bash
# Prepara el entorno para compilar Coucou en Linux.
# Uso: sudo bash ~/Claude/coucou/instalar-entorno-linux.sh
set -euo pipefail

if [[ $EUID -ne 0 || -z "${SUDO_USER:-}" ]]; then
  echo "Ejecútalo con sudo desde tu usuario: sudo bash $0" >&2
  exit 1
fi

USUARIO="$SUDO_USER"
CASA="$(getent passwd "$USUARIO" | cut -d: -f6)"
PROYECTO="$CASA/Claude/coucou/windows"

echo "==> 1/3 Paquetes del sistema (apt)"
apt-get update
apt-get install -y build-essential pkg-config \
  libwebkit2gtk-4.1-dev libgtk-layer-shell-dev libayatana-appindicator3-dev \
  librsvg2-dev libssl-dev libdbus-1-dev libxdo-dev patchelf \
  gstreamer1.0-plugins-base gstreamer1.0-plugins-good

echo "==> 2/3 Rust para $USUARIO (en ~/.cargo, no en root)"
sudo -u "$USUARIO" -H bash -c '
  if [ ! -x "$HOME/.cargo/bin/rustup" ]; then
    curl --proto "=https" --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y --profile minimal
  else
    "$HOME/.cargo/bin/rustup" update stable
  fi
'

echo "==> 3/3 Dependencias de Node del proyecto"
sudo -u "$USUARIO" -H bash -c "
  export NVM_DIR=\"\$HOME/.nvm\"
  [ -s \"\$NVM_DIR/nvm.sh\" ] && . \"\$NVM_DIR/nvm.sh\"
  cd '$PROYECTO' && npm ci
"

echo
echo "Listo. Comprobación:"
sudo -u "$USUARIO" -H bash -c '. "$HOME/.cargo/env"; rustc --version; cargo --version'
echo "Ya se puede compilar con: cd $PROYECTO && npm run pack"
