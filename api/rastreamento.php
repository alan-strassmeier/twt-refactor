<?php

declare(strict_types=1);

const BRUDAM_BASE_URL = 'https://twt.brudam.com.br/api/v1';
const MAX_REQUEST_SIZE = 2048;

header('Content-Type: application/json; charset=utf-8');
header('Cache-Control: no-store, max-age=0');
header('X-Content-Type-Options: nosniff');
header('Referrer-Policy: no-referrer');

function respond(int $status, array $payload): void
{
    http_response_code($status);
    echo json_encode($payload, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
    exit;
}

function enforceSameOrigin(): void
{
    $origin = $_SERVER['HTTP_ORIGIN'] ?? '';
    $host = strtolower(explode(':', $_SERVER['HTTP_HOST'] ?? '')[0]);

    if ($origin === '') {
        return;
    }

    $originHost = strtolower((string) parse_url($origin, PHP_URL_HOST));
    if ($originHost === '' || !hash_equals($host, $originHost)) {
        respond(403, ['status' => 0, 'message' => 'Origem não autorizada.']);
    }
}

function readPayload(): array
{
    $contentType = strtolower((string) ($_SERVER['CONTENT_TYPE'] ?? ''));
    if (strpos($contentType, 'application/json') !== 0) {
        respond(415, ['status' => 0, 'message' => 'Formato de requisição não suportado.']);
    }

    $contentLength = (int) ($_SERVER['CONTENT_LENGTH'] ?? 0);
    if ($contentLength > MAX_REQUEST_SIZE) {
        respond(413, ['status' => 0, 'message' => 'Requisição muito grande.']);
    }

    $rawBody = file_get_contents('php://input');
    $payload = json_decode($rawBody ?: '', true);

    if (!is_array($payload)) {
        respond(400, ['status' => 0, 'message' => 'Requisição inválida.']);
    }

    return $payload;
}

function enforceRateLimit(): void
{
    if (!function_exists('apcu_add') || !function_exists('apcu_inc')) {
        return;
    }

    $clientAddress = (string) ($_SERVER['REMOTE_ADDR'] ?? 'unknown');
    $cacheKey = 'twt_tracking_rate_' . hash('sha256', $clientAddress);

    if (apcu_add($cacheKey, 1, 60)) {
        return;
    }

    $requests = apcu_inc($cacheKey);
    if (is_int($requests) && $requests > 30) {
        header('Retry-After: 60');
        respond(429, ['status' => 0, 'message' => 'Muitas consultas. Aguarde um minuto.']);
    }
}

function validateInput(array $payload): array
{
    $type = strtolower(trim((string) ($payload['type'] ?? '')));
    $number = trim((string) ($payload['number'] ?? ''));
    $taxpayer = preg_replace('/\D+/', '', (string) ($payload['taxpayer'] ?? ''));
    $allowedTypes = ['nf', 'cte', 'minuta'];

    if (!in_array($type, $allowedTypes, true)) {
        respond(422, ['status' => 0, 'message' => 'Tipo de documento inválido.']);
    }

    if ($number === '' || strlen($number) > 60 || !preg_match('/^[\p{L}\p{N}.\-\/]+$/u', $number)) {
        respond(422, ['status' => 0, 'message' => 'Número do documento inválido.']);
    }

    if (in_array($type, ['nf', 'cte'], true) && !in_array(strlen($taxpayer), [11, 14], true)) {
        respond(422, ['status' => 0, 'message' => 'Informe um CPF ou CNPJ válido.']);
    }

    return [$type, $number, $taxpayer];
}

function brudamRequest(string $method, string $path, ?array $body = null, ?string $token = null): array
{
    $curl = curl_init(BRUDAM_BASE_URL . $path);
    $headers = ['Accept: application/json'];

    if ($body !== null) {
        $headers[] = 'Content-Type: application/json';
    }
    if ($token !== null) {
        $headers[] = 'Authorization: Bearer ' . $token;
    }

    $options = [
        CURLOPT_CUSTOMREQUEST => $method,
        CURLOPT_RETURNTRANSFER => true,
        CURLOPT_HTTPHEADER => $headers,
        CURLOPT_CONNECTTIMEOUT => 5,
        CURLOPT_TIMEOUT => 15,
        CURLOPT_FOLLOWLOCATION => false,
        CURLOPT_SSL_VERIFYPEER => true,
        CURLOPT_SSL_VERIFYHOST => 2,
        CURLOPT_PROTOCOLS => CURLPROTO_HTTPS
    ];

    if ($body !== null) {
        $options[CURLOPT_POSTFIELDS] = json_encode(
            $body,
            JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES
        );
    }

    curl_setopt_array($curl, $options);

    $responseBody = curl_exec($curl);
    $statusCode = (int) curl_getinfo($curl, CURLINFO_HTTP_CODE);
    $curlError = curl_error($curl);
    curl_close($curl);

    if ($responseBody === false || $curlError !== '') {
        throw new RuntimeException('Falha de comunicação com a Brudam.');
    }

    $response = json_decode($responseBody, true);
    if (!is_array($response)) {
        throw new RuntimeException('Resposta inválida da Brudam.');
    }

    return ['statusCode' => $statusCode, 'body' => $response];
}

function tokenCacheKey(string $user): string
{
    return 'twt_brudam_token_' . hash('sha256', $user);
}

function clearCachedToken(string $user): void
{
    if (function_exists('apcu_delete')) {
        apcu_delete(tokenCacheKey($user));
    }
}

function getAccessToken(string $user, string $password, bool $forceRefresh = false): string
{
    $cacheKey = tokenCacheKey($user);

    if (!$forceRefresh && function_exists('apcu_fetch')) {
        $cachedToken = apcu_fetch($cacheKey);
        if (is_string($cachedToken) && $cachedToken !== '') {
            return $cachedToken;
        }
    }

    $response = brudamRequest('POST', '/acesso/auth/login', [
        'usuario' => $user,
        'senha' => $password
    ]);
    $token = $response['body']['data']['access_key'] ?? '';

    if ($response['statusCode'] !== 200 || !is_string($token) || $token === '') {
        throw new RuntimeException('Não foi possível autenticar na Brudam.');
    }

    if (function_exists('apcu_store')) {
        apcu_store($cacheKey, $token, 300);
    }

    return $token;
}

function trackingPath(string $type, string $number, string $taxpayer): string
{
    $routes = [
        'nf' => ['/tracking/ocorrencias/cnpj/nf', ['documento' => $taxpayer, 'numero' => $number]],
        'cte' => ['/tracking/ocorrencias/cnpj/cte', ['documento' => $taxpayer, 'numero' => $number]],
        'minuta' => ['/tracking/ocorrencias/minuta', ['codigo' => $number]]
    ];

    [$path, $query] = $routes[$type];
    return $path . '?' . http_build_query($query, '', '&', PHP_QUERY_RFC3986);
}

function normalizeTrackingResponse(array $response, string $type, string $number): array
{
    $events = [];
    $deliveryForecast = '';
    $deliveryTime = '';
    $minuteStatus = '';
    $volumeCount = '';
    $forecastKeys = ['previsao_entrega', 'previsaoEntrega', 'data_previsao_entrega', 'previsao'];
    $forecastTimeKeys = ['hora_previsao_entrega', 'previsao_entrega_hora', 'horaPrevisaoEntrega', 'hora_previsao', 'previsao_hora', 'hora_entrega_prevista'];
    $statusKeys = ['status_minuta', 'statusMinuta', 'situacao_minuta', 'situacaoMinuta'];
    $volumeKeys = ['volumes_transportado', 'volumes_transportados', 'volumesTransportado', 'volumesTransportados', 'total_volumes', 'volumes', 'qtd_volumes', 'quantidade_volumes', 'numero_volumes', 'num_volumes', 'volume'];

    $readFirstValue = static function (array $source, array $keys): string {
        foreach ($keys as $key) {
            if (isset($source[$key]) && trim((string) $source[$key]) !== '') {
                return trim((string) $source[$key]);
            }
        }
        return '';
    };

    foreach (($response['data'] ?? []) as $document) {
        if (!is_array($document)) {
            continue;
        }

        if ($deliveryForecast === '') {
            $deliveryForecast = $readFirstValue($document, $forecastKeys);
        }
        if ($minuteStatus === '') {
            $minuteStatus = $readFirstValue($document, $statusKeys);
        }
        if ($deliveryTime === '') {
            $deliveryTime = $readFirstValue($document, $forecastTimeKeys);
        }
        if ($volumeCount === '') {
            $volumeCount = $readFirstValue($document, $volumeKeys);
        }

        foreach (($document['dados'] ?? []) as $event) {
            if (!is_array($event)) {
                continue;
            }

            if ($deliveryForecast === '') {
                $deliveryForecast = $readFirstValue($event, $forecastKeys);
            }
            if ($minuteStatus === '') {
                $minuteStatus = $readFirstValue($event, $statusKeys);
            }
            if ($deliveryTime === '') {
                $deliveryTime = $readFirstValue($event, $forecastTimeKeys);
            }
            if ($volumeCount === '') {
                $volumeCount = $readFirstValue($event, $volumeKeys);
            }

            $events[] = [
                'code' => (string) ($event['status'] ?? ''),
                'date' => (string) ($event['data'] ?? ''),
                'description' => (string) ($event['descricao'] ?? $event['message'] ?? 'Atualização de rastreamento'),
                'note' => (string) ($event['obs'] ?? '')
            ];
        }
    }

    usort($events, static function (array $first, array $second): int {
        return strcmp($second['date'], $first['date']);
    });

    $completedDeliveryAt = '';
    foreach ($events as $event) {
        if (stripos($event['description'], 'ENTREGA REALIZADA') !== false) {
            $completedDeliveryAt = $event['date'];
            break;
        }
    }

    if ($deliveryForecast !== '' && $deliveryTime !== '' && !preg_match('/\b\d{1,2}:\d{2}\b/', $deliveryForecast)) {
        $deliveryForecast .= ' ' . $deliveryTime;
    }

    $minuteStatusLabels = [
        '1' => 'EMISSÃO REALIZADA',
        '2' => 'CARGA MANIFESTADA',
        '3' => 'ENTREGA EM TRÂNSITO',
        '4' => 'PENDÊNCIA',
        '5' => 'DEPÓSITO',
        '6' => 'FINALIZADA',
        '7' => 'CONFERÊNCIA',
        '10' => 'GERAL',
        '11' => 'POSITIVA',
        '12' => 'PRÉ-EMISSÃO',
        '13' => 'CANCELADA',
        '14' => 'COMPLEMENTO'
    ];
    if ($minuteStatus !== '') {
        $minuteStatus = $minuteStatusLabels[$minuteStatus] ?? 'Status da minuta: ' . $minuteStatus;
    }

    return [
        'status' => $events === [] ? 0 : 1,
        'message' => $events === [] ? 'Nenhuma ocorrência encontrada.' : 'OK',
        'data' => [
            'type' => $type,
            'document' => $number,
            'deliveryForecast' => $deliveryForecast,
            'minuteStatus' => $minuteStatus,
            'volumeCount' => $volumeCount,
            'completedDeliveryAt' => $completedDeliveryAt,
            'events' => $events
        ]
    ];
}

if (($_SERVER['REQUEST_METHOD'] ?? '') !== 'POST') {
    header('Allow: POST');
    respond(405, ['status' => 0, 'message' => 'Método não permitido.']);
}

enforceSameOrigin();
enforceRateLimit();
[$type, $number, $taxpayer] = validateInput(readPayload());

$user = getenv('BRUDAM_API_USER') ?: '';
$password = getenv('BRUDAM_API_PASSWORD') ?: '';

if (!preg_match('/^[A-Fa-f0-9]{32}$/', $user) || !preg_match('/^[A-Fa-f0-9]{64}$/', $password)) {
    respond(503, ['status' => 0, 'message' => 'Integração de rastreamento não configurada.']);
}

try {
    $token = getAccessToken($user, $password);
    $response = brudamRequest('GET', trackingPath($type, $number, $taxpayer), null, $token);

    if ($response['statusCode'] === 401) {
        clearCachedToken($user);
        $token = getAccessToken($user, $password, true);
        $response = brudamRequest('GET', trackingPath($type, $number, $taxpayer), null, $token);
    }

    if ($response['statusCode'] === 404) {
        respond(404, ['status' => 0, 'message' => 'Nenhuma ocorrência encontrada.']);
    }
    if ($response['statusCode'] < 200 || $response['statusCode'] >= 300) {
        throw new RuntimeException('A Brudam recusou a consulta.');
    }

    $normalized = normalizeTrackingResponse($response['body'], $type, $number);
    respond($normalized['status'] === 1 ? 200 : 404, $normalized);
} catch (Throwable $error) {
    error_log('[tracking] ' . $error->getMessage());
    respond(502, ['status' => 0, 'message' => 'Rastreamento temporariamente indisponível.']);
}
