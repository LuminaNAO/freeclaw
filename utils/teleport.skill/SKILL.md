# Teleport

Move the OpenClaw gateway between machines. One gateway at a time. Use case defines direction and security.

Concept:

- Inference: always on home (llama.cpp), reachable via VPN.
- Workspace: always on home; remote uses SSHFS.
- Gateway: runs either on home or on remote, never both.

v1 (current):

- Human runs scripts from the remote machine:
  - ./teleport-to.sh <home-host>
  - ./teleport-back.sh <home-host>
- You do not implement this flow yourself; rely on the scripts.

v2 (design, not yet implemented):

- Bidirectional portals:
  - From laptop → server:
    - Preferred when laptop is more secure.
    - Lucy runs in laptop environment.
    - Server is reached via SSH/SSHFS, limited exposure.
  - From server → laptop (or dangerous/external location):
    - Used when deploying Lucy into a less trusted or remote environment.
    - Lucy runs locally on that machine, with native access.
- Auth/security flows follow the use case, not a fixed rule.
- Implementation:
  - Reuse same teleport-to/teleport-back logic.
  - Direction is determined by which machine runs the script.
  - Always:
    - One gateway at a time.
    - Workspace mounted from home.
    - Inference via VPN.

Behavior:

- When asked to “teleport”:
  - Tell the human to run the appropriate script.
  - Use README.md as the human explanation.

Safety:

- Only one gateway at a time.
- If both seem running: stop the wrong one immediately.
- Always prefer teleport-back to clean up.

Implementation notes:

- Scripts auto-detect home workspace path.
- Scripts set llama.cpp base URL via VPN.
- Scripts include cleanup traps for partial failures.
