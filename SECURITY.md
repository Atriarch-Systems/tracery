# Security policy

Report vulnerabilities privately through [GitHub's Report a vulnerability form](https://github.com/Atriarch-Systems/tracery-graph/security/advisories/new).
Do not include credentials, private traces, or exploit details in public issues.
Include the revision/version, deployment mode, reproduction, and expected impact.
There is no guaranteed response time. The latest 0.x source release is the supported baseline;
upgrade to the newest patch for fixes.

## Deployment boundary

The default local hub binds loopback and accepts unauthenticated access only to the
default workspace. It is for a trusted local machine. Network binds require keys
or an explicit TRACERY_AUTH=none opt-out behind another access-control boundary.
Browser origins are checked for HTTP and WebSocket requests; embedded applications
must be listed in TRACERY_ALLOWED_ORIGINS. Origin checks do not authenticate native clients.
Use TLS and least-privilege keys for network deployments.

Shares are bearer capabilities: anyone holding a valid token can read its allowed
data. Revocation closes active connections on the handling hub and every outgoing
frame rechecks the stored share. Other instances stop on their next frame/heartbeat.
Expiry closes even idle connections. Downloaded HTML/images are independent copies
and cannot be revoked. Context redaction is not general-purpose anonymization.

## Contributor CI

Fork pull requests do not run code on the organization's self-hosted runners.
Maintainers must review their code and workflows before testing on a trusted branch.
CI uses a read-only GitHub token and does not persist checkout credentials.
The runner hosts/network are operated separately and were not certified by this
repository review; do not add publishing credentials to validation jobs.
