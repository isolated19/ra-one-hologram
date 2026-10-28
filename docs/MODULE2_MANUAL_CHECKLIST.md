# Module 2 — Manual acoustic / browser checklist

Automated tests mock microphone and speech APIs. Verify these on your Windows 11 machine (Chrome or Edge recommended).

| ID | Check | Pass? |
|----|-------|-------|
| M-01 | App loads; hologram idle; Hands-Free control visible | |
| M-02 | Click **Hands-Free: Off** → browser mic permission prompt | |
| M-03 | After grant, pill shows Mic: On / Wake: monitoring | |
| M-04 | Say **Hey RA-ONE** → status LISTENING… | |
| M-05 | Ask **Who are you?** → predefined identity + TTS | |
| M-06 | Single clap → LISTENING (room dependent) | |
| M-07 | Rapid second clap ignored during cooldown | |
| M-08 | During TTS, saying Hey RA-ONE does not re-trigger | |
| M-09 | Hands-Free Off stops mic indicator / releases track (browser padlock) | |
| M-10 | Second Hands-Free enable works without page reload | |
| M-11 | Deny mic → clear error, UI does not crash | |
| M-12 | Backend stop → UI stays up (backend pill OFFLINE) | |

**Notes:** Clap detection is heuristic. Firefox may lack `webkitSpeechRecognition`. Browser TTS voices vary by OS.
