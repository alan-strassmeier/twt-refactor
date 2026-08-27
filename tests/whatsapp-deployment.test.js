'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const root = path.resolve(__dirname, '..');
const read = (relativePath) => fs.readFileSync(path.join(root, relativePath), 'utf8');

test('unidade systemd inicia depois do Docker e permanece habilitável no boot', () => {
  const unit = read('deploy/whatsapp/twt-whatsapp-stack.service');
  assert.match(unit, /^Requires=docker\.service$/m);
  assert.match(unit, /^After=docker\.service network-online\.target$/m);
  assert.match(unit, /^ExecStart=\/usr\/local\/sbin\/twt-whatsapp-stack-start$/m);
  assert.match(unit, /^WantedBy=multi-user\.target$/m);
  assert.match(unit, /^Restart=on-failure$/m);
});

test('inicializador espera dependências e descobre dinamicamente o container da aplicação', () => {
  const script = read('deploy/whatsapp/twt-whatsapp-stack-start');
  assert.match(script, /start "\$POSTGRES_CONTAINER"/);
  assert.match(script, /wait_for_state "\$POSTGRES_CONTAINER" healthy/);
  assert.match(script, /compose up -d --no-build whatsapp-baixa/);
  assert.match(script, /compose ps --all -q whatsapp-baixa/);
  assert.doesNotMatch(script, /twt-refactor-whatsapp-baixa-1/);
  assert.match(script, /start "\$TUNNEL_CONTAINER"/);
});

test('instalador cria backup e não manipula containers, volumes ou segredos', () => {
  const installer = read('deploy/whatsapp/install-autostart.sh');
  assert.match(installer, /\/var\/backups\/twt-whatsapp-autostart/);
  assert.match(installer, /systemd-analyze verify/);
  assert.match(installer, /systemctl enable --now twt-whatsapp-stack\.service/);
  assert.doesNotMatch(installer, /docker\s+(?:compose\s+)?(?:down|rm|volume)/);
  assert.doesNotMatch(installer, /whatsapp-baixa\.env/);
});
