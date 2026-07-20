# Port registry

Single source of truth for ports claimed by MantaUI services. New ports
MUST be reserved here before being added to a service's listener, so two
services can never silently collide.

Ports are loopback (`127.0.0.1`) by default; a service that needs a
public bind states so explicitly.

## MantaUI `10xxx` block

| Port | Service |
|---|---|
| _(reserved — claim before use)_ | |

## MantaUI `11xxx` block

| Port | Service |
|---|---|
| _(reserved — claim before use)_ | |

## MantaUI `12xxx` block

| Port | Service |
|---|---|
| _(reserved — claim before use)_ | |

## MantaUI `13xxx` block

| Port | Service |
|---|---|
| _(reserved — claim before use)_ | |

## MantaUI `14xxx` block

| Port | Service |
|---|---|
| _(reserved — claim before use)_ | |

## MantaUI `17xxx` block

| Port | Service |
|---|---|
| _(reserved — claim before use)_ | |

## MantaUI `18xxx` block

| Port | Service |
|---|---|
| _(reserved — claim before use)_ | |

## MantaUI `20xxx` block

| Port | Service |
|---|---|
| 20080 | serve-page file server (behind `*.pages.<domain>` vhost) |
| 20081 | gateway (hosted push fanout → APNs + DNS automation, behind `gateway.<domain>` vhost) |
