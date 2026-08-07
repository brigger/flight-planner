# Navigation Planner

A browser-based flight planner (routes, energy/fuel, NAV plans, takeoff & landing performance) for the Pipistrel Velis Electro and the Diamond DA20-C1 Katana.

## Files

- `index.html` — route planner (main page)
- `velis_performance.html` — performance data & settings
- `velis_electro_poh.json` — POH tables (rate of climb, %SOC, cruise power)

## How to run locally

```bash
npx live-server --open=index.html
```

## Deployment

- **GitHub**: https://github.com/brigger/navigation-planner
- **VPS**: 95.217.222.205 (Ubuntu 24.04, Nginx)
- **URL**: http://95.217.222.205/navigation-planner/

### Update VPS after changes

```bash
git push
ssh root@95.217.222.205 "cd /var/www/navigation-planner && git pull"
```

### Reboot VPS

```bash
ssh root@95.217.222.205 "reboot"
```

Nginx starts automatically on boot.

## TODO — DNS & HTTPS

After maillink.ch updates the DNS (A record for brigger.com → 95.217.222.205):

1. Verify it works: http://www.brigger.com/navigation-planner/
2. Enable HTTPS:
   ```bash
   ssh root@95.217.222.205 "certbot --nginx -d brigger.com -d www.brigger.com"
   ```
   This automatically gets a free SSL certificate and configures Nginx for HTTPS with auto-redirect.

## Aircraft model

**Pipistrel Velis Electro**

| Parameter | Value |
|---|---|
| Nominal battery | 24.8 kWh |
| Climb power | 48 kW at Vy (75 KIAS) |
| Cruise power | 20–36 kW (selectable) |
| Descent | Power-off glide, 15:1 ratio at 70 KIAS |
| ROC | POH table, interpolated by altitude & ISA deviation |
| %SOC | POH table, interpolated by SOH |

## How it works

Climb: ROC from POH table (1,000 ft bands, altitude & ISA-deviation interpolated). Energy from %SOC table scaled by actual vs reference ROC (600 ft/min).

Cruise: speed and %SOC from POH power setting tables.

Descent: power-off glide (0 %SOC), distance from glide ratio.

Includes takeoff (5–10 %SOC) and arrival (straight-in 5% or traffic pattern 13%).

Reserve SOC configurable (default 30%).
