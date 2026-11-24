---
'incur': patch
---

Fixed the Bash completion hook on Bash 3.2 (macOS `/bin/bash`): it registers without `-o nosort` when Bash rejects that option, and no longer leaves a `\001` marker on group candidates.
