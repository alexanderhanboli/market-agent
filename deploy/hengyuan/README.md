# Hengyuan deployment

Canonical application source: alexanderhanboli/market-agent. Keep upstream pointing
at xang1234/market-agent; develop integration changes on codex/* branches. Rebase or
merge upstream in reviewed batches. Do not put account snapshots or credentials in
this repository. The existing private Sites project remains the publishing source
for the capital dashboard, stock-screener and the built market-agent assets.

Build: `cd web && VITE_HENGYUAN_SITES=true npm run build -- --base=/market-agent/`.
The hosted build uses hash routing, so deep links do not collide with the capital
site. Its /v1 API is proxied by the private Site to a bearer-authenticated Mac
gateway. The gateway overwrites browser identity headers and signs a fixed owner
workspace identity for the loopback-only upstream services. The Site access policy
is the outer identity boundary. Never expose upstream development service ports.

The Mac must be awake, online and running Docker. PostgreSQL stores research;
existing account data and account refresh jobs remain outside this application.
Free sources are optional fallbacks and may be delayed, unavailable or rate limited.
No frozen golden data or recorded AI replies are used in this deployment.

Local secrets belong in ignored .env.dev or owner-only runtime configuration.
Discovery and scheduled research agents are not enabled by this deployment.

Runtime service: `com.hengyuan.market-agent.runtime`; tunnel service:
`com.hengyuan.market-agent.tunnel`. Both are login agents. Provider configuration
is in ignored `.env.providers`; the Settings page can update LLM values there.
After changing Polygon configuration, restart the runtime login agent. Select
DeepSeek's currently documented `deepseek-flash` model by default.

The current Cloudflare quick tunnel URL changes when its process restarts. Until
a stable named tunnel is configured, update MARKET_AGENT_BRIDGE_URL in Sites and
redeploy after a tunnel restart. Never expose the bridge without bearer auth.
