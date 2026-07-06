# Akron Asset URLs

The bot stores files in Cloudflare R2, but public Discord embeds and catalog entries should use Akron-branded URLs:

```text
https://akron.micr.dev/catalog/index.json
https://akron.micr.dev/maps/<map-id>/<pack-id>.akr
https://akron.micr.dev/maps/<map-id>/<pack-id>/capture.webp
https://akron.micr.dev/submissions/<forum>/<thread-id>/<sha>.akr
```

These routes are public-read only. Discord users never receive R2 write credentials, and the bot only writes approved public downloads after a submission passes scanning.

The Vercel website owns `akron.micr.dev`. Keep normal website routes in the website app. Route `/docs` to Mintlify from Vercel, route only the reserved public asset prefixes to R2, and route upload worker requests to the Cloudflare Upload Worker:

```text
/catalog/*
/maps/*
/submissions/*
/r2-assets/*
/uploads/*
/bot/*
```

`/uploads/*` and `/bot/*` are not public-read asset prefixes. They are Vercel external rewrites to the Upload Worker because the `micr.dev` zone is not hosted on Cloudflare. `/bot/*` endpoints are public only in the network sense; every request still requires the bot HMAC signature. Do not attach a Cloudflare Worker custom domain for `akron.micr.dev` unless the zone is moved to Cloudflare.

Set the Upload Worker's `UPLOAD_PUBLIC_UPLOAD_BASE_URL` to `https://akron.micr.dev`. The Worker uses this public origin when it returns prepared object upload URLs and signed source URLs, even though Vercel forwards the request to the underlying `workers.dev` origin.

## Bot Config

Set this in the bot deployment:

```text
AKRON_PUBLIC_ASSET_BASE_URL=https://akron.micr.dev
```

Keep `CLOUDFLARE_R2_PUBLIC_BASE_URL` configured as the raw R2 public origin. The bot still needs it as the storage fallback and as the origin the website proxies to.

## Netlify DNS

`micr.dev` uses Netlify DNS, but `akron.micr.dev` should point to Vercel because the main Akron site will be hosted there.

In the Netlify DNS panel for `micr.dev`, add the DNS record Vercel asks for after you add `akron.micr.dev` to the Vercel project. For a normal subdomain, that is usually:

```text
Type: CNAME
Name: akron
Value: cname.vercel-dns.com
TTL: automatic
```

If Vercel asks for a different target or a verification TXT record, use the exact values shown in the Vercel domain setup screen.

## Vercel Rewrites

Add rewrites to the future Akron website's `vercel.json`. Replace `<MINTLIFY_SUBDOMAIN>` with the Mintlify project subdomain and `<R2_PUBLIC_BASE_URL>` with the raw R2 public origin:

```json
{
  "rewrites": [
    {
      "source": "/docs",
      "destination": "https://<MINTLIFY_SUBDOMAIN>.mintlify.dev/docs"
    },
    {
      "source": "/docs/:match*",
      "destination": "https://<MINTLIFY_SUBDOMAIN>.mintlify.dev/docs/:match*"
    },
    {
      "source": "/catalog/:path*",
      "destination": "<R2_PUBLIC_BASE_URL>/catalog/:path*"
    },
    {
      "source": "/uploads/:path*",
      "destination": "<UPLOAD_WORKER_URL>/uploads/:path*"
    },
    {
      "source": "/bot/:path*",
      "destination": "<UPLOAD_WORKER_URL>/bot/:path*"
    },
    {
      "source": "/maps/:map/:pack.akr",
      "destination": "<R2_PUBLIC_BASE_URL>/packs/:map/:pack.akr"
    },
    {
      "source": "/maps/:map/:pack/capture.webp",
      "destination": "<R2_PUBLIC_BASE_URL>/captures/:map/:pack.webp"
    },
    {
      "source": "/submissions/:path*",
      "destination": "<R2_PUBLIC_BASE_URL>/submissions/:path*"
    },
    {
      "source": "/r2-assets/:path*",
      "destination": "<R2_PUBLIC_BASE_URL>/:path*"
    }
  ]
}
```

DNS cannot send `/docs` to Mintlify directly because DNS only routes hostnames. Vercel must receive `akron.micr.dev` first and rewrite `/docs` to Mintlify.

Do not route `/assets/*` to R2. The Akron website uses that prefix for its own landing-page images and icons.
