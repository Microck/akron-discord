# Akron Asset URLs

The bot stores files in Cloudflare R2, but public Discord embeds and catalog entries should use Akron-branded URLs:

```text
https://akron.micr.dev/catalog/index.json
https://akron.micr.dev/maps/<map-id>/<pack-id>.akr
https://akron.micr.dev/maps/<map-id>/<pack-id>/capture.webp
https://akron.micr.dev/submissions/<forum>/<thread-id>/<sha>.akr
```

The website owns `akron.micr.dev`. Keep normal website routes such as `/` and `/docs` in the website app, and proxy only the reserved asset prefixes to R2:

```text
/catalog/*
/maps/*
/submissions/*
/assets/*
```

## Bot Config

Set this in the bot deployment:

```text
AKRON_PUBLIC_ASSET_BASE_URL=https://akron.micr.dev
```

Keep `CLOUDFLARE_R2_PUBLIC_BASE_URL` configured as the raw R2 public origin. The bot still needs it as the storage fallback and as the origin the website proxies to.

## Netlify DNS

In the Netlify DNS panel for `micr.dev`, add:

```text
Type: CNAME
Name: akron
Value: <your-akron-site>.netlify.app
TTL: automatic
```

Then add `akron.micr.dev` as a custom domain on the Netlify site that will serve the Akron website.

## Netlify Proxy Rules

Add these rules to the future Akron website's public `_redirects` file, replacing `<R2_PUBLIC_BASE_URL>` with the raw R2 public origin:

```text
/catalog/* <R2_PUBLIC_BASE_URL>/catalog/:splat 200
/maps/:map/:pack.akr <R2_PUBLIC_BASE_URL>/packs/:map/:pack.akr 200
/maps/:map/:pack/capture.webp <R2_PUBLIC_BASE_URL>/captures/:map/:pack.webp 200
/submissions/* <R2_PUBLIC_BASE_URL>/submissions/:splat 200
/assets/* <R2_PUBLIC_BASE_URL>/:splat 200
```

If the website framework also owns `/catalog/*`, use a server route or Netlify Edge Function instead of `_redirects`, but keep the same public URL contract.
