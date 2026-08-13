'use strict';

const EMPTY_VALUE = '';

const text = (value) => value === undefined || value === null
  ? EMPTY_VALUE
  : String(value).trim();

const firstValue = (source, keys) => {
  for (const key of keys) {
    const value = text(source?.[key]);
    if (value) return value;
  }
  return EMPTY_VALUE;
};

const formatDate = (value) => {
  const normalized = text(value);
  const match = normalized.match(/^(\d{4})-(\d{2})-(\d{2})/);
  return match ? `${match[3]}/${match[2]}/${match[1]}` : normalized;
};

const formatTime = (value) => {
  const normalized = text(value);
  if (!normalized) return EMPTY_VALUE;
  return /^\d{2}:\d{2}$/.test(normalized) ? `${normalized}:00` : normalized;
};

const formatDecimal = (value) => {
  const normalized = text(value);
  if (!normalized) return EMPTY_VALUE;
  if (/^-?\d+(?:\.\d+)?$/.test(normalized)) {
    return Number(normalized).toFixed(2);
  }
  return normalized;
};

const addressParts = (source, prefix) => ({
  place: firstValue(source, [
    `local_${prefix}`, `${prefix}_local`, `nome_${prefix}`, `${prefix}_nome`
  ]),
  address: firstValue(source, [
    `endereco_${prefix}`, `${prefix}_endereco`, `logradouro_${prefix}`
  ]),
  district: firstValue(source, [
    `bairro_${prefix}`, `${prefix}_bairro`
  ]),
  city: firstValue(source, [
    `cidade_${prefix}_nome`, `${prefix}_cidade_nome`, `cidade_${prefix}`
  ]),
  state: firstValue(source, [
    `uf_${prefix}`, `${prefix}_uf`
  ]),
  phone: firstValue(source, [
    `telefone_${prefix}`, `fone_${prefix}`, `${prefix}_telefone`, `${prefix}_fone`
  ])
});

const cityAndState = ({ city, state }) => {
  if (!state || new RegExp(`\\b${state}$`, 'i').test(city)) return city;
  return [city, state].filter(Boolean).join(' - ');
};

const normalizeCollection = (payload) => {
  const rawData = payload?.data;
  const source = Array.isArray(rawData) ? rawData[0] : rawData;
  if (!source || typeof source !== 'object') {
    throw new Error('A Brudam não retornou os dados da coleta.');
  }

  const pickup = addressParts(source, 'coleta');
  const delivery = addressParts(source, 'entrega');
  const initialTime = formatTime(firstValue(source, [
    'hora_inicial_coleta', 'hIni', 'hora_inicio_coleta'
  ]));
  const finalTime = formatTime(firstValue(source, [
    'hora_final_coleta', 'hFim', 'hora_fim_coleta'
  ]));

  return {
    id: firstValue(source, ['id_coleta', 'id', 'coleta']),
    requester: firstValue(source, ['solicitante', 'xSoli', 'nome_solicitante']),
    pickupDate: formatDate(firstValue(source, ['data_coleta', 'dColeta'])),
    pickupTime: [initialTime, finalTime].filter(Boolean).join(' até as '),
    pickup: { ...pickup, city: cityAndState(pickup) },
    delivery: { ...delivery, city: cityAndState(delivery) },
    notes: firstValue(source, ['observacao', 'observacoes', 'obs', 'xObs']),
    volumes: formatDecimal(firstValue(source, ['volumes', 'qtde_volumes_total', 'qVol'])),
    weight: formatDecimal(firstValue(source, ['peso', 'peso_real', 'qPeso'])),
    carrier: firstValue(source, [
      'cia_embarque', 'companhia_embarque', 'transferencia', 'responsavel_coleta'
    ]),
    service: firstValue(source, ['servico', 'nome_servico', 'xServ', 'cServ']),
    route: firstValue(source, ['trecho', 'nome_trecho', 'xTrecho'])
  };
};

const buildCollectionMessage = (collection) => [
  `Prezado, segue abaixo os dados da coleta ${collection.id}`,
  'Solicitante:',
  collection.requester,
  'Data para coleta:',
  `${collection.pickupDate}${collection.pickupTime ? ` das ${collection.pickupTime}` : ''}`,
  'Local de coleta:',
  collection.pickup.place,
  'Endereço:',
  collection.pickup.address,
  'Bairro:',
  collection.pickup.district,
  'Cidade / Uf:',
  collection.pickup.city,
  'Telefone:',
  collection.pickup.phone,
  'Observação:',
  collection.notes,
  'Volumes:',
  collection.volumes,
  'Peso:',
  collection.weight,
  'Cia de embarque / Transferencia:',
  collection.carrier,
  'Serviço:',
  collection.service,
  'Trecho:',
  collection.route,
  'Local de entrega:',
  collection.delivery.place,
  'Endereço:',
  collection.delivery.address,
  'Bairro:',
  collection.delivery.district,
  'Cidade / Uf:',
  collection.delivery.city,
  'Considerações gerais:',
  '1. Caso o horário e prazo de coleta não possam ser atendidos favor nos informar imediatamente.',
  '2. Horário de Coleta, Endereço, Peso, Quantidade e Medidas dos volumes vide coleta em anexo.',
  '3. Assim que concluída a entrega favor informar imediatamente, após o embarque repassar os dados e custo da coleta imediatamente.'
].join('\n');

module.exports = { normalizeCollection, buildCollectionMessage };
