# Security release 52998b21

The previous publication failed in npm ci because Replit Socket Security Policy blocked tar 7.5.16 for a Critical CVE. This package updates only dependency manifests/lock: tar 7.5.22, Capacitor Android/iOS/core 8.4.3 (peer-aligned), proxy-addr 2.0.8. CLI remains 7.5.0. Current official npm audit reports critical 0; high 24/moderate 7/low 6 remain recorded. No firewall, install-script or registry bypass.

Source: 52998b21428048da5dc78c998f0db2a8c254023b85d5af4095b05e53375da1ee; 314 inputs. Only package.json and package-lock.json changed; 312 other production inputs are byte-identical to source95. All client JS/CSS/fonts remain byte-identical. Server bundle differs only by injected source identifier; .vite manifest binding is updated.

Build receipt: bf38d6aa43b9f721f9dad2074a507ea5f7948336049d759c9cd53d4c55911c68; 17 artifacts. Full CI with scripts, TSC, 357 backend tests and both prebuilt verifier paths passed locally. Native Node20 install/bundle/run still requires new observations; old proofs are not rebound. All 68 requirements and accepted UI/bot/data behavior remain in scope.

Migration of 10 accounts was already verified and made READY at epoch1 using source95. Those historical receipts remain source95; this dependency-only application update does not repeat, relabel or restore that migration. No publication or release announcement is claimed by this package.
