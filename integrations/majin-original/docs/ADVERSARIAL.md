# Adversarial Classification — Del 10E (10-Z)

Six named vector classes against MAJIN, each with a REGRESSION test that must
stay green forever. If any breach returns from production or sabotage, the
matching test goes red — no silent degradation.

| id | clasificare | real attack surface | defense proven | test |
|---|---|---|---|---|
| V1a | `path.detect` | `..` traversal inside fs paths | `resolveIn` flags `outside=true` always | V1(a) |
| V1b | `path.protect` | writes into `/etc`, `/boot% `, `%ProgramFiles`… | protected root → `destructive` level → ask-without-human = denied, no bytes land | V1(b) |
| V1c | `cmd.never` | fork-bomb / `mkfs` / `dd of=/dev` | guard `neverOn` hard-block even with `confirm:true` | V1(c) |
| V2 | `config.proto` | `{"__proto__":{"pwned":true}}` in config patches | identity segments dropped in `merge`, `getPath` own-prop only, `setPath` refuses, raw store prototype clean | V2 |
| V3 | `args.bound` | 4MB content + control chars through fs tools | write bounded-by-policy, read truncated with VISIBLE marker + `meta.truncated` | V3 |
| V4 | `bypass.readOnly` | readOnly runner writing directly | registry refuses with `read_only`, zero side-effects | V4 |
| V5 | `content.eval` | hostile JavaScript stored as file | stored byte-exact as DATA; nothing evaluates; no exec side-effects | V5 |
| V6 | `prompt.inject` | injection inside tool results/docs | PromptGuard scan + tool-result flagging + infinite-loop cap | `test/adversarial.test.js` 12/12 |

Sabotage-proof: removing the merge-filter (E1) → V2 instantly red; removing the
contract-engine guards (T1/T2/T3, Del 4D) → their tests red. Restored → green.
