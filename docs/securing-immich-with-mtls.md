# Securing Immich with mTLS using a reverse proxy

Immich supports using a custom client certificate on both web and mobile apps, so it's one of the easiest and safest ways to limit access to only clients of your choice.

This guide is about Immich rather than IPP: it locks Immich itself down so that only IPP is reachable from the internet, the setup described in [Why not expose Immich directly?](/introduction#why-not-expose-immich-directly). The reverse-proxy examples below apply mTLS to Immich only; IPP stays open to the public.

## Authenticating with mutual TLS

The process of generating the certificates is the same regardless of which reverse proxy you use. Place the resulting `certs/` folder inside a volume that is mounted into your reverse proxy container: `./data/certs` for the Caddy example below, `./config/certs` for Traefik.

### Generate your client certificate

This is a basic way to generate a certificate for a user. If it's only you using your own homelab, then you'll just need to make one certificate.

This certificate will last for ~10 years (although of course you can revoke it at any time by deleting it from your reverse proxy key store).

```bash
#!/bin/bash

mkdir -p certs

# Generate CA certificates
openssl genrsa -out certs/client-ca.key 4096
openssl req -new -x509 -nodes -days 3600 -key certs/client-ca.key -out certs/client-ca.crt

# Generate a certificate signing request
openssl req -newkey rsa:4096 -nodes -keyout certs/client.key -out certs/client.req

# Have the CA sign the certificate requests and output the certificates.
openssl x509 -req -in certs/client.req -days 3600 -CA certs/client-ca.crt -CAkey certs/client-ca.key -set_serial 01 -out certs/client.crt

echo
echo "Please enter a STRONG password. Many clients *require* a password for you to be able to import the certificate, and you want to protect it."
echo

# Convert the certificate to PKCS12 format (for import into browser)
openssl pkcs12 -export -out certs/client.pfx -inkey certs/client.key -in certs/client.crt

# Clean up
rm certs/client.req
```

## Using Caddy
### Caddy docker-compose.yaml

```yaml
services:
  caddy:
    image: caddy:2
    restart: unless-stopped
    cap_add:
      - NET_ADMIN
    ports:
      - "6443:443"
      - "6443:443/udp"
    volumes:
      - ./Caddyfile:/etc/caddy/Caddyfile:Z
      - ./site:/srv:Z
      - ./data:/data:Z
      - ./config:/config:Z
```
### Configure Caddyfile

```
https://immich.mydomain.com {
    tls {
        client_auth {
            mode require_and_verify
            trusted_ca_cert_file /data/certs/client-ca.crt
        }
    }
    reverse_proxy internal_server.lan:2283
}
```

## Using Traefik
### Traefik docker-compose.yaml
```yaml
services:
  traefik:
    image: traefik:3.5
    container_name: traefik
    hostname: traefik
    restart: always
    environment:
      - TZ=Europe/Madrid
    ports:
      - 80:80
      - 443:443
    volumes:
      - ./config:/etc/traefik
```

### Configure Traefik dynamic file
```yaml
http:
  services:
    immich:
      loadBalancer:
        servers:
          - url: "http://immich:2283"

  routers:
    immich:
      entryPoints:
        - websecure
      service: immich
      rule: "Host(`immich.mydomain.com`)"
      tls:
        certResolver: letsencrypt
        options: mtlsOptions

tls:
  options:
    mtlsOptions:
      minVersion: VersionTLS12
      cipherSuites:
        - TLS_ECDHE_ECDSA_WITH_AES_128_GCM_SHA256
        - TLS_ECDHE_RSA_WITH_AES_128_GCM_SHA256
        - TLS_ECDHE_ECDSA_WITH_AES_256_GCM_SHA384
        - TLS_ECDHE_RSA_WITH_AES_256_GCM_SHA384
      clientAuth:
        caFiles:
          - /etc/traefik/certs/client-ca.crt
        clientAuthType: RequireAndVerifyClientCert
```
