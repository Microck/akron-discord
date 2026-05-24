# Akron Asset URLs

The bot stores files in Cloudflare R2, but public Discord embeds and catalog entries should use Akron-branded URLs:

```text
https://akron.micr.dev/catalog/index.json
https://akron.micr.dev/maps/<map-id>/<pack-id>.akr
https://akron.micr.dev/maps/<map-id>/<pack-id>/capture.webp
https://akron.micr.dev/submissions/<forum>/<thread-id>/<sha>.akr
```

The Vercel website owns `akron.micr.dev`. Keep normal website routes in the website app. Route `/docs` to Mintlify from Vercel, and route only the reserved asset prefixes to R2:

```text
/catalog/*
/maps/*
/submissions/*
/r2-assets/*
```

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
