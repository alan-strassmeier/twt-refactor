#!/usr/bin/env bash
set -euo pipefail

readonly SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
readonly SOURCE_SCRIPT="${SCRIPT_DIR}/twt-whatsapp-stack-start"
readonly SOURCE_UNIT="${SCRIPT_DIR}/twt-whatsapp-stack.service"
readonly TARGET_SCRIPT=/usr/local/sbin/twt-whatsapp-stack-start
readonly TARGET_UNIT=/etc/systemd/system/twt-whatsapp-stack.service
readonly BACKUP_ROOT=/var/backups/twt-whatsapp-autostart
readonly STAMP="$(date +%Y%m%d-%H%M%S)"
readonly BACKUP_DIR="${BACKUP_ROOT}/${STAMP}"

if [[ "$EUID" -ne 0 ]]; then
  printf 'Execute com sudo: sudo %s\n' "$0" >&2
  exit 1
fi

for source_file in "$SOURCE_SCRIPT" "$SOURCE_UNIT"; do
  if [[ ! -f "$source_file" ]]; then
    printf 'Arquivo de origem não encontrado: %s\n' "$source_file" >&2
    exit 1
  fi
done

install -d -o root -g root -m 700 "$BACKUP_DIR"

script_existed=false
unit_existed=false
unit_was_enabled=false
unit_was_active=false
if systemctl is-enabled --quiet twt-whatsapp-stack.service 2>/dev/null; then
  unit_was_enabled=true
fi
if systemctl is-active --quiet twt-whatsapp-stack.service 2>/dev/null; then
  unit_was_active=true
fi
if [[ -e "$TARGET_SCRIPT" ]]; then
  cp -a -- "$TARGET_SCRIPT" "${BACKUP_DIR}/twt-whatsapp-stack-start"
  script_existed=true
fi
if [[ -e "$TARGET_UNIT" ]]; then
  cp -a -- "$TARGET_UNIT" "${BACKUP_DIR}/twt-whatsapp-stack.service"
  unit_existed=true
fi

rollback() {
  local status="$?"
  trap - ERR

  if [[ "$script_existed" == true ]]; then
    cp -a -- "${BACKUP_DIR}/twt-whatsapp-stack-start" "$TARGET_SCRIPT"
  else
    rm -f -- "$TARGET_SCRIPT"
  fi
  if [[ "$unit_existed" == true ]]; then
    cp -a -- "${BACKUP_DIR}/twt-whatsapp-stack.service" "$TARGET_UNIT"
  else
    rm -f -- "$TARGET_UNIT"
  fi
  systemctl daemon-reload || true
  if [[ "$unit_was_enabled" == true ]]; then
    systemctl enable twt-whatsapp-stack.service || true
  else
    systemctl disable twt-whatsapp-stack.service || true
  fi
  if [[ "$unit_was_active" == false ]]; then
    systemctl stop twt-whatsapp-stack.service || true
  fi
  printf 'Instalação falhou; arquivos anteriores restaurados de %s.\n' \
    "$BACKUP_DIR" >&2
  exit "$status"
}
trap rollback ERR

install -o root -g root -m 755 "$SOURCE_SCRIPT" "$TARGET_SCRIPT"
install -o root -g root -m 644 "$SOURCE_UNIT" "$TARGET_UNIT"
systemd-analyze verify "$TARGET_UNIT"
systemctl daemon-reload
systemctl enable --now twt-whatsapp-stack.service

trap - ERR
printf 'Inicialização automática instalada com sucesso.\n'
printf 'Backup anterior: %s\n' "$BACKUP_DIR"
systemctl is-enabled twt-whatsapp-stack.service
systemctl is-active twt-whatsapp-stack.service
