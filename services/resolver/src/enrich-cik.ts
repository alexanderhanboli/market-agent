import type { TickerDiscoveryProvider } from './discovery.ts';
import type { QueryExecutor } from './lookup.ts';
// Fill only a missing SEC identity on the same issuer, from an exact ticker/venue.
export async function enrichMissingCik(db: QueryExecutor,input: { issuerId: string; cik?: string; ticker?: string; mic?: string },provider?: TickerDiscoveryProvider): Promise<boolean> {
 if(input.cik || !input.ticker || !input.mic || !provider)return false;
 const matches=(await provider.discoverTicker(input.ticker)).filter(row=>row.ticker.toUpperCase()===input.ticker!.toUpperCase()&&row.mic===input.mic&&row.cik);
 const ciks=[...new Set(matches.map(row=>String(Number(row.cik))))].filter(cik=>/^\d+$/.test(cik)&&Number(cik)>0);
 if(ciks.length!==1)return false;
 const result=await db.query(`update issuers set cik = $2, updated_at = now() where issuer_id = $1 and cik is null and not exists (select 1 from issuers other where other.cik = $2 and other.issuer_id <> $1) returning issuer_id`,[input.issuerId,ciks[0]]);
 return result.rows.length===1;
}
