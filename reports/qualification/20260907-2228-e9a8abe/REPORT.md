# Qualification Run Report 20260907-2228-e9a8abe

> This run used Prototype Mode isolation. It demonstrates protocol, ledger, and orchestration correctness. It does not support a channel-isolation or side-channel-resistance claim, because both Babies executed in the same process.

> Non-confirmatory software-qualification run executed in Prototype Mode: not pre-registered, no Base anchor submitted, every run disposition is invalid by construction (SPECIFICATION.md §7.2), and nothing here is a research finding.

## Metadata

- Generated at: 2026-09-07T22:29:43.635Z
- Software commit: e9a8abe21cc5043b5ab75434b9f9be6b9668db4b
- Node version: v24.20.0
- Run set id: 20260907-2228-e9a8abe
- E03 conditions: disabled, constant, random, shuffled, normal, oracle
- E03 seeds per condition: 5
- E03 evaluation episodes per run: 200
- E03 symbol inventory: 32 (max 1 symbol(s)/message)
- E03 alpha: 0.0500
- E03 equivalence bounds: [0.2000, 0.3000]
- E03 oracle lower bound: 0.9000
- E03 separation lower bound: 0.6000
- E11 seeds: 3
- E11 training turns: 3000
- E11 evaluation turns: 200
- E11 symbol inventory: 32
- E11 learner options: learningRate=1.0000, temperature=0.5000, messageLength=1

## E03: chance-baseline controls

| condition | seeds | mean success | sd | TOST decision | Holm-adjusted p | pooled Wilson 95% CI |
| --- | --- | --- | --- | --- | --- | --- |
| disabled | 5 | 0.2380 | 0.0104 | equivalent | 0.0030 | [0.2126, 0.2654] |
| constant | 5 | 0.2380 | 0.0104 | equivalent | 0.0030 | [0.2126, 0.2654] |
| random | 5 | 0.2380 | 0.0104 | equivalent | 0.0030 | [0.2126, 0.2654] |
| shuffled | 5 | 0.2380 | 0.0104 | equivalent | 0.0030 | [0.2126, 0.2654] |
| normal-no-learning | 5 | 0.2380 | 0.0104 | equivalent | 0.0030 | [0.2126, 0.2654] |

Oracle adequacy: bootstrap lower bound 1.0000 vs floor 0.9000 — meets.

### Oracle separation (Holm step-down)

| condition | paired lower bound vs 0.6000 | decision |
| --- | --- | --- |
| disabled | 0.7520 | meets |
| constant | 0.7525 | meets |
| random | 0.7530 | meets |
| shuffled | 0.7530 | meets |
| normal-no-learning | 0.7540 | meets |

Appendix D clauses 1-3 qualify: true
Unmet criteria: none

All evidence bundles verified: true

## E11: from-scratch RL naming game

| seed | last-window training success | evaluation success | Wilson 95% CI | chance p (one-sided vs 0.25) | vocabulary utilization | symbol entropy (bits) | policy hash constant | verifier exit |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | 0.9600 | 0.9300 | [0.8859, 0.9578] | 0.0000 | 75.0% | 4.3989 | true | 0 |
| 2 | 0.9500 | 0.9750 | [0.9428, 0.9893] | 0.0000 | 78.1% | 4.4367 | true | 0 |
| 3 | 0.9800 | 0.9800 | [0.9497, 0.9922] | 0.0000 | 78.1% | 4.4875 | true | 0 |

Aggregate evaluation success: mean 0.9617, sd 0.0275 across 3 seed(s).

### What this shows / does not show

**Shows:** the pipeline executes end to end through the scenario engine, learner adapters, the Symbol Gateway, the atomic Evidence Writer, checkpoints, Experiment Records, bundle export, and independent verification.

**Does not show:** research-grade isolation (Mode P only, not Mode R), anchoring (no Base Sepolia transaction was submitted), pre-registration (none was filed), or statistical power (these are developer seed counts, not the SPECIFICATION.md §15.3 floor) — and therefore no E00-E03 qualification in EXPERIMENT-NOTEBOOK.md's sense.

**Next steps:** fund a Base Sepolia wallet and set `ALD_BASE_RPC_URL` and `ALD_ANCHOR_KEY_FILE`, register the protocol on OSF, then run in Mode R.

## Per-run appendix

| runId | condition/seed | state | dispositions | configurationHash | final checkpoint | replayDigest | verifier exit |
| --- | --- | --- | --- | --- | --- | --- | --- |
| e03-disabled-s1 | disabled/s1 | aborted-sealed | invalid, invalid, invalid | sha256:db1b97fd30c81d17ee58d0daaa4fbf2dbf7293ee6b3660ca7363c87d05cf5220 | sha256:a6be8c88f2490610b541bcaa263019b5c45811e1dd62146732dc7f4f37f226d3 | sha256:73393bb37c6e9700ee9ef7878f94891ebaef945cf9e751f6c96744e58a6f6f4e | 0 |
| e03-disabled-s2 | disabled/s2 | aborted-sealed | invalid, invalid, invalid | sha256:a2dff38537475b6ad976ba77c01b97e66bcfcc00344dd3c49936ad243ff74b64 | sha256:d05e009174e69959d79d2087ad4da98ac38651432fd143b396c1b6a531ec4d0d | sha256:c864a06c0a9df2e7192cc7675de736879ebe1f786f085b588c9e46c96a9d4f82 | 0 |
| e03-disabled-s3 | disabled/s3 | aborted-sealed | invalid, invalid, invalid | sha256:7ecb55478bbde599f80004a383c793ab156e3dc6ec7db98e9b6e498c55a07f8f | sha256:70bfbcf8c3d06852d0864e7248e9665571031d3361e8ecb3ff71ea73a2d48b40 | sha256:1749471610a0dceb65bd4c98c2f384b1f6d36fa06483f66d3606ecb418df2115 | 0 |
| e03-disabled-s4 | disabled/s4 | aborted-sealed | invalid, invalid, invalid | sha256:91fd32038c366d6837db29809ef231e3d99bef97f1aabc3acb0766268eb05bc9 | sha256:70f3facd36b6978923e7b29ebed0df78fa7a9d929b3cb8047fc15948b718298a | sha256:c9739aba0292e1f0cd685b121709cffa5886d54a032c232a30a5f01047490b9d | 0 |
| e03-disabled-s5 | disabled/s5 | aborted-sealed | invalid, invalid, invalid | sha256:31f59c9d6469ae47e4ef4a55b2ad07cb7a8ddad3db18d304f32ecd1cf246733a | sha256:e012775acb5dd0234698ac51241ba44d88c6fcc349b2414d54939d8f2669b3a5 | sha256:2958fd91d12b930e5550dfc2c1beebcb7bed834f37394019bae01ab3207ff95d | 0 |
| e03-constant-s1 | constant/s1 | aborted-sealed | invalid, invalid, invalid | sha256:ec406dfe7478f20683e55cf70923aedf2c34924981f11b825f622020fb1207cb | sha256:bef7847796bc62a2d53dd772ead9fdd9f396cd4d1780bdddd62ec0e0e051c4dc | sha256:20467035d1c21f03f86c7e50f51fd52a0c18456ee98c69c092f07ee492d14fd2 | 0 |
| e03-constant-s2 | constant/s2 | aborted-sealed | invalid, invalid, invalid | sha256:3ad7e5fca02572ebabf129ae1a26d6316d5d7f7b64287d525a6aba8773fdb198 | sha256:7edf3d1b673675a54890c25dd27c0b1b52bb56fc1655d2a56248801a56cf6c7d | sha256:09eb7a684a6cc57f23abc48eaa606c61503f3768650f5e38edc71a12fce6a448 | 0 |
| e03-constant-s3 | constant/s3 | aborted-sealed | invalid, invalid, invalid | sha256:3d96e0356692b00b9bb71042360914ebd894570f247e641af53fe0a20feb70c2 | sha256:b187d8a34e1208f69472fb9e82fd426c1c4debe439ebe6d68647c3f73503a510 | sha256:4abeb557aefc0e7292b85c85c48142d3f323062206205d498a38c113b838e3d1 | 0 |
| e03-constant-s4 | constant/s4 | aborted-sealed | invalid, invalid, invalid | sha256:271aa18d049f0390db130c66b54fe198d0302dc6a75ced376778dfa03f4b316e | sha256:6d6c883fba9cafde5dbe14e903deb9ea08640114739e3ae7491fa157c0ae7d36 | sha256:686540ef82121bec638413e4064727810c021287281837cb40b2ad61793a6df3 | 0 |
| e03-constant-s5 | constant/s5 | aborted-sealed | invalid, invalid, invalid | sha256:4b9c362db29c14271c48a6fe4964a9c5fe14ce5a4568585f5ecad87e1fdafe0e | sha256:52fc902620d711e5dac95897fe29027c2d2d4a1b41cfb271043a7b75985af787 | sha256:b0e4e4dea9fc7ad731228603798e43d41e596b91c00dee874902ff77d5a0506f | 0 |
| e03-random-s1 | random/s1 | aborted-sealed | invalid, invalid, invalid | sha256:a8aa1f4c67ce92c4894023a2c56b2ef80ea11999de7975e459cbeda50cbdf05c | sha256:128c0ebd5d48fd286984ba6693565b295aba1d30c2e8597c5ea9afbdeea32db8 | sha256:10a3712cfe8e30d1f74487acfde148995a0fc994f1e3d49392ad4849dbb9f260 | 0 |
| e03-random-s2 | random/s2 | aborted-sealed | invalid, invalid, invalid | sha256:3acb733092810765e7429cf8f1408c3d2ad0aa29603b28be17d8da71ba5f54ba | sha256:dbf77a18b89ecc8f1d34d8657a7a484a9746f868b87963e276a563a9c40d1339 | sha256:37de879815ed2bbbd23813343640a603a8f499d401fe5533a0d3ca45b6759bf9 | 0 |
| e03-random-s3 | random/s3 | aborted-sealed | invalid, invalid, invalid | sha256:1b4c6e7cafa5c9eab3b3fcae442fa4ba530fa1b79c8d9df4e17e425599ee6eda | sha256:880c7840b49f22cb3118eda684828614e0442b63888af506ec6801ed90847c38 | sha256:231656f43fc6fa063c5f8206a36501f82130197c39c2b639b55cdb2c1d8e4cad | 0 |
| e03-random-s4 | random/s4 | aborted-sealed | invalid, invalid, invalid | sha256:ad8b057c70a7169e7a6fbdb4dfc6f456a3c85844793511e3d5170fa52fabf715 | sha256:8eb013c0e1a376d8989bd3495b48e12d6e9c982418a8ec784efd36e3efcd273c | sha256:db64e6e97723d1335efc94b201800dcc41bf13b7ac221ebedf65fde688110d88 | 0 |
| e03-random-s5 | random/s5 | aborted-sealed | invalid, invalid, invalid | sha256:ff84f9c349039cb761e78c9951947c00ab68ce762a4991160bbeb1ab534ca458 | sha256:618d4e6be55595f8102d4744f9d1929a0eb48996f2343755f81834ca4dd4ef08 | sha256:31e958d727103f4e149cd6ffbbe349b492f7f729e61cd2fd8b68b3d5d216d906 | 0 |
| e03-shuffled-s1 | shuffled/s1 | aborted-sealed | invalid, invalid, invalid | sha256:f09c8f047457c356cb2ee472893d1e02d37e7771c8bb10ca8c00b880cf712bfd | sha256:06d42057d89355e960f4c2f7ba65f63e469d79a27f3f4a97b04c091657d966aa | sha256:11d721fa1dd84b4800cf1deda59e7a28fe5a1189750b1ca90771ef3fafb5d267 | 0 |
| e03-shuffled-s2 | shuffled/s2 | aborted-sealed | invalid, invalid, invalid | sha256:bf50bb2e868937f7fddb1b115f7162f62c760836764b43877b1aafd2f354e6a5 | sha256:868ed579a5704b7d1049dc1265b798672c921b819a02073af15dc4d9b678df87 | sha256:91d58af46781336a63603f98876513b95554704aff1a066e1544167c2cdf85cc | 0 |
| e03-shuffled-s3 | shuffled/s3 | aborted-sealed | invalid, invalid, invalid | sha256:074cb387b463d4638d6e817fa3ae5e5ce0db513f5e749f836b829be7205f0705 | sha256:ab6470dab1e017d1cd8084cb24723b37d7994cf97ca9f40ade7b37a939905e55 | sha256:227a802048280d70899cd3806d7fb8cd1d480681bcd275bba391f9d249a611fb | 0 |
| e03-shuffled-s4 | shuffled/s4 | aborted-sealed | invalid, invalid, invalid | sha256:2f9fc75e8dbc86c33aa23abf800372ad243a0ccf5ff5493d32d1065aa5bea642 | sha256:0880137857a9cd0fbea3f192cf715ba03e21c0027349484342dfdc111fc86ed3 | sha256:408872ac44c274e35e1eb8036b1e16e6d079311be0982dcfb54180f6950306fa | 0 |
| e03-shuffled-s5 | shuffled/s5 | aborted-sealed | invalid, invalid, invalid | sha256:4d518412fb3bfc202b476f76ef1c7e440fb6807336ea410cf269ca401611a330 | sha256:f6f6edf4ef790439078fccfbdf97eb0ce9270f5794cfa1a1753386c0bc994636 | sha256:477f1d660c8aa9c7d4ed7d9a0010c1c3ad792b00cd9e29862c334977f155721b | 0 |
| e03-normal-s1 | normal/s1 | aborted-sealed | invalid, invalid, invalid | sha256:072e110c9ab839f3c81521c9523e4275b6579e75c5257d1a69640729d978f9d3 | sha256:e3c6abd03da3d78b93b0d60337f350f0f9379130b7fc9e0e500495da131a2c37 | sha256:e111984b27158469349e0e96dd635c5508a6d6b5a514d9207590f1b793a1d8c2 | 0 |
| e03-normal-s2 | normal/s2 | aborted-sealed | invalid, invalid, invalid | sha256:0b2bbfa365c1c64acd45eecb5262e8ef8f2dc6255c8de38cfe35d31d44e77f4e | sha256:e3c9820314ece7b762ae1e6b00193108e759520d776cc7ed7f18e9455f079ea3 | sha256:e7afde2c5a6c455ba9d653c47e470ad2aa94abd3cab9bf182c92f24fe4c1c9fb | 0 |
| e03-normal-s3 | normal/s3 | aborted-sealed | invalid, invalid, invalid | sha256:c6f15ba63f2808617dfc77d0808a8fe692e12cf9ec72d08d6cffc14408837e04 | sha256:092965d2a807e21724b3d16967157e1f08f4e09d427aaa9ed7270ec5a67f38bd | sha256:521dacbfec59367afeb64e78fe98ecadf634113dc81cee87831114c1853c8ea7 | 0 |
| e03-normal-s4 | normal/s4 | aborted-sealed | invalid, invalid, invalid | sha256:c92517bf835673d5a037eab848db8586cb981294819fb9f93f0c0fbc36ae6c80 | sha256:11ab15e5b6176992484de525f6214f71b4e3181534deb5354f61eb6716177667 | sha256:ffcbbe88bbd31460f9ee066b4cb309abb4cfab296d041036def6a17b2af3d9ba | 0 |
| e03-normal-s5 | normal/s5 | aborted-sealed | invalid, invalid, invalid | sha256:71a0dc1ce84cf155e52130a77d3cab1ff0d103454a2f17497c29449fcb4cbce4 | sha256:00a93256bfe1316e52577e8ea36b9b02b1ba314f5769a587a60b67f8fa359cdb | sha256:5abd8c454f94d3e5e81093d19d455deb335051869bb2537157d1a78e041a81fa | 0 |
| e03-oracle-s1 | oracle/s1 | aborted-sealed | invalid, invalid, invalid | sha256:b9c8ef0b870c8de2b8bc8ebb59353dc0189a70b0e3fc4b59ead737a8f9095481 | sha256:da9f9a5d2fb6987658451701404047250d143f5d474c732953d82f0602d5dd0a | sha256:6c8ba44225bdff0496436be082628f7a3be64cc514b1edd10c9cc31c553fbeeb | 0 |
| e03-oracle-s2 | oracle/s2 | aborted-sealed | invalid, invalid, invalid | sha256:254cffb3f193f55091c3de83b28bc08ff2483ceacc020937a758ded922b5a097 | sha256:18460c6112c76d09a7abc61b81ccee532f1764ac0d5411037775835508f60ce2 | sha256:38932260136c0dc879381299cd88c126544fe40a324b22d392ed512c6e981011 | 0 |
| e03-oracle-s3 | oracle/s3 | aborted-sealed | invalid, invalid, invalid | sha256:e1f73bb32ab9a2a5da12a2e54acac4c3e34365603a92a8c56cd74985758b1fbf | sha256:afa6027456b0729f64ad777ea1d3033c0b750c9e2b57fb3ad77701239808c9b7 | sha256:499ffe912c2ac1a9e318925d3b307f89102b9a803fd75a2c0c35aa7ae9210a42 | 0 |
| e03-oracle-s4 | oracle/s4 | aborted-sealed | invalid, invalid, invalid | sha256:a82d10666d1b4efafcafc2812236a2e7c88b9d079e4f72d99a12c6fc52c71ca2 | sha256:7a2b280a45f7b6218d49ec6dd4ea0ad49b7c6cd26c711d7b4a198db6558e06b9 | sha256:519d949465330dce3e7ddae1c096388ff23efba7e18f014889817803e249126e | 0 |
| e03-oracle-s5 | oracle/s5 | aborted-sealed | invalid, invalid, invalid | sha256:7411ff24369a61be2492f04b68365111dcf59272db6ea50bb1291d083f0db919 | sha256:1926bdf9f6c0ed776d420607f66c200993581c265c5cb6feb2051b8adc405596 | sha256:b25ccb1ee564e5709ad92c932263576948fbfa5409057b177ba719580032983a | 0 |
| e11-s1 | s1 | aborted-sealed | invalid, invalid, invalid | sha256:6be249840ae992ad3639338d514a6109c24ed506224f9d9f2ba553b7cca065f4 | sha256:cc7e99f6b3d2b6bf8cbb8750a2d96c0524c024f71bfc8850165e44b7fc2607a3 | sha256:585c804fb6b4819de80e46b9e0d15bd7fa532206dbeaa4555766cb2f3b411f68 | 0 |
| e11-s2 | s2 | aborted-sealed | invalid, invalid, invalid | sha256:d19cd8228b60d591a1d053a8f1a8520e41cdc61ce1ed7f5d095ac59ae3d270e3 | sha256:70e05d73103a3d00389a8897de8b14f3f674ab84362c56a2a764510358cf0b52 | sha256:3873414c8f57bf3751ec167549ff95d67fcaa461332e4a6920c7a1904ca246ac | 0 |
| e11-s3 | s3 | aborted-sealed | invalid, invalid, invalid | sha256:198abb54d6160ab93d5d21610d16d2268aeffe19dca4a73b0f9645e98cd5cac5 | sha256:4fbea5789d621ae5c8505507a80d5760376678bbe90b7fd774e17848d58b2b87 | sha256:8e3a51802037d9b8f4478b32c06b6f4751521eb21dc62f6fa7c30f6054329859 | 0 |
