'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { normalizeCollection, buildCollectionMessage } = require('../server/coleta/message');
const coletaHandler = require('../api/coleta');

test('normaliza a resposta documentada da consulta de coleta', () => {
  const collection = normalizeCollection({
    status: 1,
    data: {
      id_coleta: '7776',
      data_coleta: '2026-08-13',
      hora_inicial_coleta: '08:00',
      hora_final_coleta: '17:00',
      local_coleta: 'RESPITEC SOLUCOES INTEGRADAS',
      endereco_coleta: 'RUA BENITO ANTONIO BALDAN - 182',
      cidade_coleta_nome: 'FAZENDA RIO GRANDE - PR',
      local_entrega: 'WHITE MARTINS GASES INDUSTRIAIS LTDA',
      endereco_entrega: 'AVENIDA MARGINAL SERGIO CANCIAN - 5093',
      cidade_entrega_nome: 'SERTAOZINHO - SP',
      responsavel_coleta: 'GVR TRANSPORTES LTDA',
      volumes: 1,
      peso: '10.00'
    }
  });

  assert.equal(collection.id, '7776');
  assert.equal(collection.pickupDate, '13/08/2026');
  assert.equal(collection.pickupTime, '08:00:00 até as 17:00:00');
  assert.equal(collection.pickup.city, 'FAZENDA RIO GRANDE - PR');
  assert.equal(collection.volumes, '1.00');
  assert.equal(collection.weight, '10.00');
  assert.equal(collection.carrier, 'GVR TRANSPORTES LTDA');
});

test('aproveita campos adicionais da Brudam sem inventar dados ausentes', () => {
  const collection = normalizeCollection({ data: {
    id: 7776,
    xSoli: 'CAIO (RESPITEC)',
    dColeta: '13/08/2026',
    hIni: '08:00:00',
    hFim: '17:00:00',
    local_coleta: 'RESPITEC',
    endereco_coleta: 'RUA TESTE - 182',
    bairro_coleta: 'PIONEIROS',
    cidade_coleta_nome: 'FAZENDA RIO GRANDE',
    uf_coleta: 'PR',
    telefone_coleta: '41999999999',
    observacoes: 'Coletar na recepção',
    volumes: 1,
    peso: 10,
    servico: 'RODO EXPRESS',
    trecho: 'CWB > RAO',
    local_entrega: 'WHITE MARTINS',
    endereco_entrega: 'AVENIDA TESTE - 5093',
    bairro_entrega: 'SETOR INDUSTRIAL',
    cidade_entrega_nome: 'SERTAOZINHO',
    uf_entrega: 'SP'
  }});
  const message = buildCollectionMessage(collection);

  assert.match(message, /^Prezado, segue abaixo os dados da coleta 7776/);
  assert.match(message, /Solicitante:\nCAIO \(RESPITEC\)/);
  assert.match(message, /Data para coleta:\n13\/08\/2026 das 08:00:00 até as 17:00:00/);
  assert.match(message, /Cidade \/ Uf:\nFAZENDA RIO GRANDE - PR/);
  assert.match(message, /Serviço:\nRODO EXPRESS/);
  assert.match(message, /Trecho:\nCWB > RAO/);
  assert.match(message, /Considerações gerais:\n1\./);
});

test('recusa uma resposta sem objeto de coleta', () => {
  assert.throws(
    () => normalizeCollection({ status: 1, data: [] }),
    /não retornou os dados da coleta/i
  );
});

test('permite CORS por padrão e aplica allowlist quando configurada', () => {
  const previous = process.env.COLETA_ALLOWED_ORIGINS;
  delete process.env.COLETA_ALLOWED_ORIGINS;
  assert.equal(coletaHandler.allowedOrigin('chrome-extension://abc'), true);
  assert.equal(coletaHandler.allowedOrigin('moz-extension://abc'), true);
  assert.equal(coletaHandler.allowedOrigin('null'), true);
  assert.equal(coletaHandler.allowedOrigin(''), true);
  assert.equal(coletaHandler.allowedOrigin('https://site-malicioso.test'), true);

  process.env.COLETA_ALLOWED_ORIGINS = 'chrome-extension://permitida';
  assert.equal(coletaHandler.allowedOrigin('chrome-extension://permitida'), true);
  assert.equal(coletaHandler.allowedOrigin('chrome-extension://outra'), false);
  if (previous === undefined) delete process.env.COLETA_ALLOWED_ORIGINS;
  else process.env.COLETA_ALLOWED_ORIGINS = previous;
});

test('valida o token interno da extensão com comparação segura', () => {
  const previous = process.env.COLETA_EXTENSION_TOKEN;
  process.env.COLETA_EXTENSION_TOKEN = 'a'.repeat(40);
  assert.equal(coletaHandler.validToken(`Bearer ${'a'.repeat(40)}`), true);
  assert.equal(coletaHandler.validToken(`Bearer ${'b'.repeat(40)}`), false);
  assert.equal(coletaHandler.validToken('Bearer curto'), false);
  if (previous === undefined) delete process.env.COLETA_EXTENSION_TOKEN;
  else process.env.COLETA_EXTENSION_TOKEN = previous;
});

const invokeHandler = async ({ method = 'GET', origin, authorization, query = {} }) => {
  const headers = {};
  let body = '';
  const req = {
    method,
    query,
    headers: {
      origin,
      authorization,
      'x-forwarded-for': '127.0.0.1'
    },
    socket: { remoteAddress: '127.0.0.1' }
  };
  const res = {
    statusCode: 200,
    setHeader: (name, value) => { headers[name] = value; },
    end: (value = '') => { body = value; }
  };
  await coletaHandler(req, res);
  return { statusCode: res.statusCode, headers, body: body ? JSON.parse(body) : null };
};

test('endpoint exige token mesmo quando CORS está aberto', async () => {
  const previous = process.env.COLETA_EXTENSION_TOKEN;
  process.env.COLETA_EXTENSION_TOKEN = 'a'.repeat(40);
  const result = await invokeHandler({
    origin: 'https://site-malicioso.test',
    authorization: `Bearer ${'b'.repeat(40)}`,
    query: { id: '7776' }
  });
  assert.equal(result.statusCode, 401);
  assert.equal(result.body.status, 0);
  assert.equal(result.headers['Access-Control-Allow-Origin'], '*');
  if (previous === undefined) delete process.env.COLETA_EXTENSION_TOKEN;
  else process.env.COLETA_EXTENSION_TOKEN = previous;
});

test('endpoint rejeita token incorreto e número inválido', async () => {
  const previous = process.env.COLETA_EXTENSION_TOKEN;
  process.env.COLETA_EXTENSION_TOKEN = 'a'.repeat(40);

  const unauthorized = await invokeHandler({
    origin: 'chrome-extension://abc',
    authorization: `Bearer ${'b'.repeat(40)}`,
    query: { id: '7776' }
  });
  assert.equal(unauthorized.statusCode, 401);

  const invalidId = await invokeHandler({
    origin: 'chrome-extension://abc',
    authorization: `Bearer ${'a'.repeat(40)}`,
    query: { id: '../7776' }
  });
  assert.equal(invalidId.statusCode, 422);

  if (previous === undefined) delete process.env.COLETA_EXTENSION_TOKEN;
  else process.env.COLETA_EXTENSION_TOKEN = previous;
});
