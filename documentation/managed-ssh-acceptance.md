# Disposable SSH Git acceptance

Run from `backend` with the locked Poetry environment:

```sh
SECOND_BRAIN_SSH_ACCEPTANCE=1 poetry run pytest tests/integration/test_managed_ssh_git.py -v
```

Install Git and OpenSSH client/server tools first. The host must permit loopback
TCP and Unix-domain sockets. The fixture runs as the current user; it does not
create users, change privileges, alter system SSH configuration or use an
existing agent. A root invocation also needs OpenSSH's normal privilege
separation environment. Restricted development runtimes may reject agent socket
creation; that is a failed acceptance attempt, not a skipped successful proof.
The tests are opt-in and skipped during the ordinary unit suite.

Each case creates an owned private temporary directory beneath the current
user's home (so OpenSSH StrictModes accepts the authorized-key ancestors), fresh Ed25519 host/client keys,
an owned SSH agent, an SSH server bound only to loopback, and a bare Git target.
The expected host public key is obtained from the generated fixture directly;
no network scan or trust-on-first-use is involved. Only the temporary authorized
client key is accepted. Readiness requires a real authenticated Git request.
Processes and their private process groups are stopped during cleanup and the
temporary directory is removed, including on assertion failure.

The [CI workflow](../.github/workflows/managed-ssh.yml) exercises five cases:

- Real `ManagedGitSync` push and pull, followed by restarted clients returning
  the original acknowledged request receipts without advancing remote refs.
- Missing host trust and a different valid host key both refuse push and pull.
- An empty agent and an agent containing only an unauthorized key both refuse
  push and pull. Local content revisions and remote refs remain unchanged.
  After deliberate trust/key repair, the same request IDs resume against their
  original reviewed revisions; acknowledged retries preserve their receipts.

CI retains only the synthetic JUnit report for seven days; readiness failures
include synthetic transport diagnostics. Key files, agent sockets, complete
server-log files, environment dumps and vault directories are never uploaded.

This proves the agent and explicit host-trust path against a disposable OpenSSH
server. It does not prove a private hosted Git provider's deploy-key permissions,
operator agent mounts, production firewall configuration or physical-device
operation. Those remain separate operator acceptance steps described in the
[Git sync guide](managed-git-sync.md).
