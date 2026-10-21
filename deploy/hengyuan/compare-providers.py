"""Compare personal Polygon entitlements with the existing read-only Robinhood MCP.

Run from the repository root. No keys are printed, sent in URL parameters, or
written into results. Requires HENGYUAN_CAPITAL_CHECKOUT to locate the user's
existing independently authorized, Keychain-backed MCP client.
"""
import datetime as dt
import json
import os
from pathlib import Path
import sys
import time
import urllib.error
import urllib.parse
import urllib.request


def load_key():
    for line in Path('.env.providers').read_text().splitlines():
        if line.startswith('POLYGON_API_KEY='):
            return line.split('=', 1)[1].strip().strip('\"\'')
    return ''


def main():
    key = load_key()
    if not key:
        raise SystemExit('POLYGON_API_KEY is empty. Fill the ignored local .env.providers file first.')
    sys.path.insert(0, os.environ['HENGYUAN_CAPITAL_CHECKOUT'])
    from capital_dashboard.robinhood_direct import DirectReadMcp
    allowed = {'get_equity_quotes', 'get_equity_historicals', 'search'}
    report = {'capturedAt': dt.datetime.now(dt.timezone.utc).isoformat(), 'symbols': ['AAPL', 'NVDA'], 'polygon': {}, 'robinhood': {}, 'comparison': {}}

    def polygon(label, path):
        start = time.monotonic()
        request = urllib.request.Request('https://api.polygon.io'+path, headers={'Authorization': 'Bearer '+key, 'Accept': 'application/json'})
        try:
            with urllib.request.urlopen(request, timeout=25) as response:
                payload = json.load(response)
                report['polygon'][label] = {'http': response.status, 'ms': round((time.monotonic()-start)*1000), 'payload': payload}
        except urllib.error.HTTPError as error:
            # Status is sufficient to distinguish auth/entitlement/quota failure;
            # do not retain raw upstream error messages or request URLs.
            report['polygon'][label] = {'http': error.code, 'ms': round((time.monotonic()-start)*1000)}
        except Exception as error:
            report['polygon'][label] = {'error': type(error).__name__}

    now = dt.datetime.now(dt.timezone.utc)
    end = now.date()
    start = end-dt.timedelta(days=30)
    with DirectReadMcp(budget=150) as client:
        def robinhood(label, name, args):
            if name not in allowed:
                raise PermissionError('Market-data reads only')
            before = time.monotonic()
            try:
                result = client.rpc('tools/call', {'name': name, 'arguments': args})
                if result.get('isError'):
                    report['robinhood'][label] = {'error': 'tool_error'}
                    return
                payload = result.get('structuredContent')
                if payload is None:
                    payload = json.loads('\n'.join(x['text'] for x in result.get('content', []) if x.get('type') == 'text'))
                report['robinhood'][label] = {'ms': round((time.monotonic()-before)*1000), 'payload': payload}
            except Exception as error:
                report['robinhood'][label] = {'error': type(error).__name__}
        robinhood('quotes', 'get_equity_quotes', {'symbols': ['AAPL', 'NVDA']})
        robinhood('daily', 'get_equity_historicals', {'symbols': ['AAPL', 'NVDA'], 'start_time': str(start)+'T00:00:00Z', 'end_time': str(end)+'T00:00:00Z', 'interval': 'day', 'bounds': 'regular', 'adjustment_type': 'split'})
        # Five requests maximum: suitable for an initial basic-tier entitlement
        # check. Do not automatically retry quota failures.
        polygon('reference', '/v3/reference/tickers/AAPL')
        polygon('quote_AAPL', '/v2/snapshot/locale/us/markets/stocks/tickers/AAPL')
        for symbol in ['AAPL', 'NVDA']:
            polygon('daily_'+symbol, f'/v2/aggs/ticker/{symbol}/range/1/day/{start}/{end-dt.timedelta(days=1)}?adjusted=true&sort=asc&limit=5000')
        polygon('minute_AAPL', f'/v2/aggs/ticker/AAPL/range/1/minute/{end}/{end}?adjusted=true&sort=asc&limit=5000')
    rh = report['robinhood'].get('daily', {}).get('payload', {}).get('data', {}).get('results', []) or []
    for item in rh:
        symbol = item['symbol']
        bars = {bar['begins_at'][:10]: bar for bar in item.get('bars', []) or [] if bar and not bar.get('interpolated')}
        poly = report['polygon'].get('daily_'+symbol, {}).get('payload', {}).get('results', []) or []
        # Date matching only: Polygon daily timestamps use ET trading-day starts;
        # provider timestamps are retained for further timezone inspection.
        differences = []
        for bar in poly:
            day = dt.datetime.fromtimestamp(bar['t']/1000, dt.timezone.utc).date().isoformat()
            other = bars.get(day)
            if not other:
                continue
            differences.append({'day': day, 'close_diff': float(bar['c'])-float(other['close_price']), 'volume_diff': float(bar['v'])-float(other['volume'])})
        report['comparison'][symbol] = {'matched_days': len(differences), 'daily_differences': differences, 'scope': 'split-adjusted daily bars; volume differences may reflect trade eligibility or venue coverage; inspect before choosing a provider'}
    destination = Path('.dev/provider-comparison.json')
    destination.write_text(json.dumps(report, ensure_ascii=False, indent=2))
    destination.chmod(0o600)
    print(json.dumps({'report': str(destination), 'polygon_statuses': {k: v.get('http', v.get('error')) for k, v in report['polygon'].items()}, 'matched_days': {k: v['matched_days'] for k,v in report['comparison'].items()}}, ensure_ascii=False))

if __name__ == '__main__':
    main()
