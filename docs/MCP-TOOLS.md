# MCP 能力契约

由 `node scripts/check-mcp-contract.mjs --write` 从实际 stdio tools/list 和工作流目录生成。CI 使用无参数命令检查漂移。

版本 1.6.0；169 个工具（102 只读、64 写入、3 模型）；28 个工作流。

| 工具 | 权限 | 输入契约 SHA-256 | 输出契约 SHA-256 |
|---|---|---|---|
| `add_project_material` | write | `58c170114ca6c8a0c6d975fb858a701b747b85e55835e76b4270acf34ab5fe4e` | `b577c7e23babd11c60ae8b9d22ef3d210604ccd3ee6841d5583f280d575d63b6` |
| `analyze_application_jd` | llm | `0c0bc3ebd0e76ab4c3a261d733c96997929ef03e85cce0d9ebed8e1131017785` | `54ec419f0cfed7d6af83d9139557eef9f63413edfef01443206c9cdef58c45ec` |
| `answer_mock_interview` | write | `5de04ed9eb98eb458d6f9247e31fd3b3dbc9b327df1fbe357540252f4f39fee3` | `b577c7e23babd11c60ae8b9d22ef3d210604ccd3ee6841d5583f280d575d63b6` |
| `answer_series_interview` | write | `d902932b113d498193f2a90105a4257985ca065eaa63bbec70e02aa25a36b45b` | `b577c7e23babd11c60ae8b9d22ef3d210604ccd3ee6841d5583f280d575d63b6` |
| `append_mcp_upload` | write | `1142f01fdb071818667d3e7c1c4e619ce61d0e790829ae0643abb18d86affe9f` | `7ff73896563525ebf0afd8c9b316c9b23ecaad6de66eb219f054b818e75b8a88` |
| `begin_mcp_upload` | write | `93df411ca01732f7fba26ecc4265bc01590fdce7af51e166a4f8a3958d63af5c` | `7ff73896563525ebf0afd8c9b316c9b23ecaad6de66eb219f054b818e75b8a88` |
| `bookmark_practice_question` | write | `d22694fabf534faf2cf9651281b69e9b0677180aa155377b604ac6128adcceca` | `b577c7e23babd11c60ae8b9d22ef3d210604ccd3ee6841d5583f280d575d63b6` |
| `branch_resume_version` | write | `4ca4bf201edb03196ee4e0cb765474cdc397daf79d805801f51761c362fcb4ae` | `b577c7e23babd11c60ae8b9d22ef3d210604ccd3ee6841d5583f280d575d63b6` |
| `cancel_mcp_job` | write | `2c0596318d5f09fa1c477dce11e99d7280a2cbdb269f6a4571f86143304a5839` | `3ae4a1504bfec48054ef8e421745ebf98b8bbcaaf42a8393262c11b398276612` |
| `capture_project_repository` | write | `3595e39f5743d7ee9b03e8f68df9258ea97188a79813dd98792490a5bc63200e` | `a27e797b34345b97b3582d90ca5b57f81fb95c8219949478e6df59982df5f936` |
| `cleanup_mcp_cache` | write | `da6b1ca54dbfff58e0b1c2f0ae3f14aa48fa5ea38929073da4bb947b39fae3f2` | `bd823735c0a5c28e2109968c46b43dac65158e71bd97d17452465d46d9fd0c44` |
| `compare_resume_versions` | read | `3a5e22b1644f47fbfde6ebb5066e5df477ec00d5e2dc9df636f881698b346ec6` | `ff6ddf576082d3697a8148d515d189982b4fa99281e0fb7f12a946517aa20b6f` |
| `complete_mcp_upload` | write | `b943b363ff1a0b38c4c50b64177e45eb508a0e6365fd7431f5c7b0a780442ce9` | `7ff73896563525ebf0afd8c9b316c9b23ecaad6de66eb219f054b818e75b8a88` |
| `create_application` | write | `d01a9344e1832a7b660befec40baab9cfa81db7e231010ed11213b69e4387bb9` | `b577c7e23babd11c60ae8b9d22ef3d210604ccd3ee6841d5583f280d575d63b6` |
| `create_notebook_category` | write | `aeaef1be04b8a9d6780d8baf47d2a1066e6ef62b91bf7913e1681ac2d9bd313e` | `b577c7e23babd11c60ae8b9d22ef3d210604ccd3ee6841d5583f280d575d63b6` |
| `create_practice_session` | write | `0ee499c35305f500b88580734d36e4f626bca8de7d5cc34d6c79abf860828dfc` | `b577c7e23babd11c60ae8b9d22ef3d210604ccd3ee6841d5583f280d575d63b6` |
| `create_preparation_task` | write | `494d59b32f6e463895f270164080b09d6d6a372457f3b87ea3cc76cbe2924e07` | `b577c7e23babd11c60ae8b9d22ef3d210604ccd3ee6841d5583f280d575d63b6` |
| `create_project` | write | `3ca3d485dd40ad62c4f4285be6fbeda28cdc9499592d505099e0c689e9badca8` | `b577c7e23babd11c60ae8b9d22ef3d210604ccd3ee6841d5583f280d575d63b6` |
| `create_resume_draft` | write | `438e43d2a35389820a356eae065848a80483ff532765d473cb14ffadd101cbc1` | `b577c7e23babd11c60ae8b9d22ef3d210604ccd3ee6841d5583f280d575d63b6` |
| `create_resume_template` | write | `e8c9705726d3dda05b3ad822134cf3f03b32ac9d953cf7caa64d7045376c3290` | `b577c7e23babd11c60ae8b9d22ef3d210604ccd3ee6841d5583f280d575d63b6` |
| `diagnose_application_resume` | llm | `0c0bc3ebd0e76ab4c3a261d733c96997929ef03e85cce0d9ebed8e1131017785` | `54ec419f0cfed7d6af83d9139557eef9f63413edfef01443206c9cdef58c45ec` |
| `draft_interview_review` | llm | `23540564e455a3e6ca8fe91ccd788706461fd6890e86565e8057ce443e6250c3` | `54ec419f0cfed7d6af83d9139557eef9f63413edfef01443206c9cdef58c45ec` |
| `export_portfolio` | write | `4e30bbe69d9e1ff05f13a86015aed38dd040fe10de128fc0e356057aa194733b` | `5ef383016de6f59948c29b4539af7147bacdce35c230621fab39b478b23178d4` |
| `export_resume` | write | `6c1a6c1e5ca9920f483ea63b124e12c1c367286bf562c768727a457cb544ec57` | `5ef383016de6f59948c29b4539af7147bacdce35c230621fab39b478b23178d4` |
| `extract_uploaded_file` | write | `b69c7da4f653cd05d1265ab3704f88b03352e78e23b7ceddd84eca6e6440d317` | `bc1994842a2d8c07884cf4d398f11dd5df736219c9e062f40dce7e425110267b` |
| `finish_mock_interview` | write | `18b5c4404334007f217c1f80a3ea3553728a97f48a93c9aff9fd9b9d39d050a5` | `b577c7e23babd11c60ae8b9d22ef3d210604ccd3ee6841d5583f280d575d63b6` |
| `finish_series_interview` | write | `36ec34952f848c818bdc41d1e11d4d9009ef53bb9b0aa69d47f3e4aa91c94a5b` | `b577c7e23babd11c60ae8b9d22ef3d210604ccd3ee6841d5583f280d575d63b6` |
| `generate_preparation_plan` | write | `1474cb2d44904a52422c4fa1681ac429dc3cd089a671c42e94249863ec6454ef` | `96e362f0c408c0d2466f2771ec475c590255b37877295f658f4dbceeaf6dc9bd` |
| `get_ai_draft` | read | `d54ec4ea57bbd42b77cbd6ddf24916f08bf3b293fbde7a20183e93b19523e86e` | `c63482d3085497cd17fced735aa97128c1fd48b2381fc5b1c8ec260a45c80811` |
| `get_ai_generation_request` | read | `acaf0fe7c133e415de14c7c3282f4f5191ab551d4d2bfa7a0af4085ae934bcc7` | `ef4f9b7d1f4cd4eeccc19a33dec39a1d11e56efa073a27c84d30029ed453cd64` |
| `get_ai_workflow_context` | read | `62be71ec06f0ca8ddd036f457b98a52c33add01dea757c2588c1f310c50a23b4` | `62744275612dc3e7595e456db4c413a1b6d672f4e17e284d0df2a7dbc8b56a6b` |
| `get_application` | read | `d54ec4ea57bbd42b77cbd6ddf24916f08bf3b293fbde7a20183e93b19523e86e` | `3f7f039a79625ddde5c5b1ae6d16321bc6aadee7b61530597cf7a95a1fc3e655` |
| `get_application_interview_questions` | read | `52c48cdf316b2cd90c74d708be6243a68d839f346011cebb81af015c5f5f254f` | `8991b7cdc5bff01521c0394c1bdd6d8f154e465153e89019b93bfd32b5e99739` |
| `get_application_stats` | read | `8fd2f3a9f585458d28f458b18645b0336925be162090e94d153d80c9a0385370` | `1bee7497b0bfedd1dca518528a50887cead14b4e6309712cfbee618b22a7ed6f` |
| `get_bank_import_result` | read | `5788be9ed4262632f55733d9d40f0613363fecc08fe0f91668581f8e7ca4d9cc` | `ff6ddf576082d3697a8148d515d189982b4fa99281e0fb7f12a946517aa20b6f` |
| `get_career_record` | read | `08fdfc0b11b837f50eef151de0847e12d1174f06e8d79776c93e9df9f13f6e02` | `ff6ddf576082d3697a8148d515d189982b4fa99281e0fb7f12a946517aa20b6f` |
| `get_career_workflow_context` | read | `bd2042c6fcbcfb9209e3eedd2fa912d6be0b8badb5512ac43b1f992ae4cc8fdd` | `ff6ddf576082d3697a8148d515d189982b4fa99281e0fb7f12a946517aa20b6f` |
| `get_diagnosis_adoption_context` | read | `0c97048eb45169cfd0baf484a45b7aa240d9cf7191baaa70ae6293b90f644d1e` | `ff6ddf576082d3697a8148d515d189982b4fa99281e0fb7f12a946517aa20b6f` |
| `get_file_extraction` | read | `5788be9ed4262632f55733d9d40f0613363fecc08fe0f91668581f8e7ca4d9cc` | `ff6ddf576082d3697a8148d515d189982b4fa99281e0fb7f12a946517aa20b6f` |
| `get_file_import_context` | read | `ba9cf8738ba4e8907fee29b48fec6f9117a2592726ad8aa53faf0b1969d28b87` | `ff6ddf576082d3697a8148d515d189982b4fa99281e0fb7f12a946517aa20b6f` |
| `get_interview` | read | `e76889e1470a1df2f12ed59416e7a80f14d5caf5de76430b6ecc056d82402176` | `18d758e2719560cccbbb3c17f6400903fd289054ec659ed8e9ad886b774e520c` |
| `get_interview_review` | read | `d54ec4ea57bbd42b77cbd6ddf24916f08bf3b293fbde7a20183e93b19523e86e` | `f2aa53142241ae288a04b197c193c2f1b79170ac638b6d22e8bc7b80e49ce65d` |
| `get_interview_series` | read | `d54ec4ea57bbd42b77cbd6ddf24916f08bf3b293fbde7a20183e93b19523e86e` | `a51583ea1d0cb72835a10d6e53dfda3f785573437ba45565d58d7b62e3fc457d` |
| `get_interview_series_context` | read | `5d8fdf2924084ce1dbcca7678e4536de8a239ca1b231e95773fd193a908471cb` | `ff6ddf576082d3697a8148d515d189982b4fa99281e0fb7f12a946517aa20b6f` |
| `get_interview_training_context` | read | `f1fcc45801f7a3ac6273e1d8d871547b93f23181ac87ce04f969f008700b800a` | `ff6ddf576082d3697a8148d515d189982b4fa99281e0fb7f12a946517aa20b6f` |
| `get_intro` | read | `d54ec4ea57bbd42b77cbd6ddf24916f08bf3b293fbde7a20183e93b19523e86e` | `0fd0458b1bf486657b507500e42aa0b56b97ca1c2dc3410614c1aa12e7b78917` |
| `get_intro_generation_context` | read | `100b3ad40f28cbe41674f330ab3e2104c6d7992220cddd8cff260fa2ae6db9c1` | `ff6ddf576082d3697a8148d515d189982b4fa99281e0fb7f12a946517aa20b6f` |
| `get_jargon_generation_context` | read | `cb591d40d0de978768b4fbf8823d54339a490c485a6019d796826747b50c2d9a` | `ff6ddf576082d3697a8148d515d189982b4fa99281e0fb7f12a946517aa20b6f` |
| `get_jd_portrait` | read | `d54ec4ea57bbd42b77cbd6ddf24916f08bf3b293fbde7a20183e93b19523e86e` | `b07681c7373ca3a4cc4edb5acd1a7c80119a864e543b0a2e9577fb60347ece88` |
| `get_mcp_job` | read | `2c0596318d5f09fa1c477dce11e99d7280a2cbdb269f6a4571f86143304a5839` | `3ae4a1504bfec48054ef8e421745ebf98b8bbcaaf42a8393262c11b398276612` |
| `get_mcp_job_result` | read | `7874ddf62bee890861cd12ba56f3ce62f09b1cd4a45cf15f54eb0c02e2ad6a44` | `ff6ddf576082d3697a8148d515d189982b4fa99281e0fb7f12a946517aa20b6f` |
| `get_mcp_status` | read | `8fd2f3a9f585458d28f458b18645b0336925be162090e94d153d80c9a0385370` | `f192e6ede80adeb428c40f068a78293f4d80a1da425013441da293b4728d1c99` |
| `get_mcp_upload` | read | `b943b363ff1a0b38c4c50b64177e45eb508a0e6365fd7431f5c7b0a780442ce9` | `7ff73896563525ebf0afd8c9b316c9b23ecaad6de66eb219f054b818e75b8a88` |
| `get_mock_interview_state` | read | `58925fa6e56670c42259b96f0544af5c253c38de8752d6da068abb3625a6b553` | `8972c4d345ae7e0a8f4216f2706fdedf2f9f00e1cd0e6cbd3ecac18c8652e063` |
| `get_notebook_entry` | read | `d54ec4ea57bbd42b77cbd6ddf24916f08bf3b293fbde7a20183e93b19523e86e` | `2d4ad92566910dba9d5f768b18e18ea6eeaafb6ec4e7a5a8363884260f5131de` |
| `get_notebook_organization_context` | read | `e27455e5e0f0f9f2e461516bed3824ef62223f73911b8485d8dadbbb1e1286c1` | `ff6ddf576082d3697a8148d515d189982b4fa99281e0fb7f12a946517aa20b6f` |
| `get_portfolio_context` | read | `93db4a28a0a5c8a4ee3b72a50c4b1c7745ce776895da89de20216fae750f0a3b` | `ff6ddf576082d3697a8148d515d189982b4fa99281e0fb7f12a946517aa20b6f` |
| `get_portfolio_sources` | read | `8109f4efeb23e1f110d3f0d2c00eff2082997f2947f7a5f104e4b9c812efdee8` | `ff6ddf576082d3697a8148d515d189982b4fa99281e0fb7f12a946517aa20b6f` |
| `get_practice_answer_context` | read | `e7a677deac04837a3faeddad57763fab6e2c11eed43e844c212ef189d80247b5` | `08b64e9d75158c8b3cffa2a489209365b0ffd6fba70bee985aa349edbf048c1f` |
| `get_practice_generation_context` | read | `20a3aa5849bb94a7724a2a844dd4bd5758609d575ca6e4fbb879c6310703625f` | `ff6ddf576082d3697a8148d515d189982b4fa99281e0fb7f12a946517aa20b6f` |
| `get_practice_question` | read | `d54ec4ea57bbd42b77cbd6ddf24916f08bf3b293fbde7a20183e93b19523e86e` | `ee01667eb09fd76b18c9eb3a52bd35c081e2ec60dd061e8c9dbe2ebce055ca9c` |
| `get_preparation_plan` | read | `79ac061d72045f0b2a8b38ed4085bdd0d49901ec7138fd627df6730877861bd3` | `96e362f0c408c0d2466f2771ec475c590255b37877295f658f4dbceeaf6dc9bd` |
| `get_project` | read | `d54ec4ea57bbd42b77cbd6ddf24916f08bf3b293fbde7a20183e93b19523e86e` | `8bb5c2d077490db6f6f45baea97493bfc1e53ac0510512317a43b2b099cc7600` |
| `get_project_material_context` | read | `cf5b00ab436bd605066e2af553f3f49c8af0d743c0fb8448fbf5b59a78eec287` | `ff6ddf576082d3697a8148d515d189982b4fa99281e0fb7f12a946517aa20b6f` |
| `get_project_summary_context` | read | `4b36735a3d0d533c2a4a5e015f987a85f98f9f5fd2ca9ffafd39fcaf6e098ee1` | `ff6ddf576082d3697a8148d515d189982b4fa99281e0fb7f12a946517aa20b6f` |
| `get_repository_capture` | read | `5788be9ed4262632f55733d9d40f0613363fecc08fe0f91668581f8e7ca4d9cc` | `ff6ddf576082d3697a8148d515d189982b4fa99281e0fb7f12a946517aa20b6f` |
| `get_repository_catalog` | read | `8109f4efeb23e1f110d3f0d2c00eff2082997f2947f7a5f104e4b9c812efdee8` | `ff6ddf576082d3697a8148d515d189982b4fa99281e0fb7f12a946517aa20b6f` |
| `get_repository_evidence_diff` | read | `b7117149b45f533c21a68ef495620f365e0c5b63687ad565ccc54a55dc6d4845` | `ff6ddf576082d3697a8148d515d189982b4fa99281e0fb7f12a946517aa20b6f` |
| `get_repository_evidence_version` | read | `caeeaefbe3e79031630e0c0f35c72360f8937d5413822cf7b5e7f092358e4d2c` | `ff6ddf576082d3697a8148d515d189982b4fa99281e0fb7f12a946517aa20b6f` |
| `get_resume` | read | `352c72bba3547f02cee8ecfd8d23f3fe9ad2a0f0b4bb22215cf66dee43bc14bc` | `f7c64d5a969e29f37136a54c976defe4da578d890796170ff66d96b9bc54df06` |
| `get_resume_avatar_context` | read | `8a7e4ee7102c73f80c834b54f7c032ed41d060bbdc653617976c96f8cb4dcb8d` | `ff6ddf576082d3697a8148d515d189982b4fa99281e0fb7f12a946517aa20b6f` |
| `get_resume_diagnosis` | read | `d54ec4ea57bbd42b77cbd6ddf24916f08bf3b293fbde7a20183e93b19523e86e` | `f51d5da9c6ee54d58a1202c6b8ae373099d1d004f4f62c24032f0374a36b6c7d` |
| `get_resume_draft_context` | read | `8a7e4ee7102c73f80c834b54f7c032ed41d060bbdc653617976c96f8cb4dcb8d` | `ff6ddf576082d3697a8148d515d189982b4fa99281e0fb7f12a946517aa20b6f` |
| `get_resume_export_context` | read | `e08bbfd6ae34b11aba3ffb18d0b1df5a052f76dde6de36c268c489d4081e6072` | `ff6ddf576082d3697a8148d515d189982b4fa99281e0fb7f12a946517aa20b6f` |
| `get_resume_layout_context` | read | `8a7e4ee7102c73f80c834b54f7c032ed41d060bbdc653617976c96f8cb4dcb8d` | `ff6ddf576082d3697a8148d515d189982b4fa99281e0fb7f12a946517aa20b6f` |
| `get_resume_template_context` | read | `34e5f41fea50ffdb146f616bbf70cf745cbcd54179b4e6600298f9ae53604d79` | `ff6ddf576082d3697a8148d515d189982b4fa99281e0fb7f12a946517aa20b6f` |
| `get_resume_version_context` | read | `a805e461dc277276c63a825621780473f20c28a352e4f332493198aab774aba3` | `ff6ddf576082d3697a8148d515d189982b4fa99281e0fb7f12a946517aa20b6f` |
| `get_review_card` | read | `499f03f0a865127840863c0ae0aec98f74339ff3a2b17d7229dd27b96ba0b6f0` | `8e2d723d932b1bd3517e9fa6a9040eca5d17d999945aa1f10704863f65f24555` |
| `get_review_submission` | read | `7d6be71776ec715d3de60b3d33602bf5fac6d4b0cff6aad97f0ab0f3a7d52034` | `bbda5149661111c96a49dc7ebe947e921d9cd7f277544e50bcd3a6f35db84f17` |
| `get_series_interview_state` | read | `56783b114bef5579e73cd1da3b2c10edfa53e2f38cd1e656ab88cfaa478b2808` | `8972c4d345ae7e0a8f4216f2706fdedf2f9f00e1cd0e6cbd3ecac18c8652e063` |
| `get_today_priorities` | read | `d87cc70bc47b74697e8be2c9da7b6d235336fd9f37555d339357b05db9bc9cad` | `4d8a919bf4dcee549f250e713fcc1e85498d7bd407cf5c756ca66e55ae6d113a` |
| `get_workflow_catalog` | read | `902c00a957e3fec4cd03420351814fbffa5084139dcf6bc4962b9ad7c8e25f6b` | `ff6ddf576082d3697a8148d515d189982b4fa99281e0fb7f12a946517aa20b6f` |
| `list_ai_drafts` | read | `c81439d851cb43df62758470b9b3e933bf1ba702c73810507ad80407e1f676aa` | `2b385985eb1c827787db1ffc3228cdf88a6fe216d890a41ca48a55dd66c5e061` |
| `list_application_history` | read | `3bba05f9dcb66a3e9b1621b0490f2b40c35967ca5df829f9fceaf147f27773f2` | `8382f1022d4ce2e182e69991ab79333423e909422c962ace13694ea3a832c2bf` |
| `list_application_interviews` | read | `3bba05f9dcb66a3e9b1621b0490f2b40c35967ca5df829f9fceaf147f27773f2` | `c6d71dd683dbd3e49d9213a1b6f474147e957e03b615db74744d7be1b670ed22` |
| `list_application_preparation_resources` | read | `55d3961a61fb2c9e7f72853a61b29a10a4d3760be118cf782f4c747a03933cb5` | `0fe55733e2f3bab9729edb9f67d278641226fd040fe44e48183c94bc6e9ce95a` |
| `list_applications` | read | `57435b5363c0498878691b47c2cf09e03e4c6ccbdd3600b498ea339221cfcfb5` | `e9e6559779f00679b7a6c504bcf84175334c8b363a57ea4d489781f5673d96ea` |
| `list_bank_directions` | read | `986ce9a330b95ad4320e169942a159ab0d2810ef4a18b2dc89683ba485232a2d` | `f83fe914af8769e5c11977e283db580bc8cb5f6c61e0d9d0b9d7e7dce94fbb61` |
| `list_bank_entries` | read | `d65797b8662b0b9dd4201a1b9eb647451833bd9fb1ef04446e29df52d9363242` | `e5ef7e7d3cfb3dace745835fe49d9bc54acdee9070c91d0ee0f03eecde36fb1a` |
| `list_career_records` | read | `0c634b214a6ef61eb24eac4b4bb84bb6579fb34eedee17146ad1043b65244073` | `66704e455d8aff2db96eec706ad714b9d9d41a4dee1c72fe6848ddd873c16021` |
| `list_interview_reviews` | read | `042d41ff76ac5a2b2c4ec0c8f0e27e223cc2c36d38677ae77a31c4103b1a575b` | `d1b64b200c7ee777eac177f7cae7443fdef5deee50aba6e84c0afe557f0b6aaf` |
| `list_interview_series` | read | `049d005f9001881440c3b2e515955e3bd142e97beaa7d69a6898f6041b8847ef` | `884be9d5af8e36c394c3b996db05e8c8379abec0423cd02a160a1e7d4f8ffe9f` |
| `list_interviews` | read | `042d41ff76ac5a2b2c4ec0c8f0e27e223cc2c36d38677ae77a31c4103b1a575b` | `8ac1de999c249313d1b961861116b4f26fab944d12122d43044fae35cd2e222f` |
| `list_intros` | read | `049d005f9001881440c3b2e515955e3bd142e97beaa7d69a6898f6041b8847ef` | `e3036c50596e4e85cf86bf2919b18e9a01d535f741f92cee23f3499467279f45` |
| `list_jd_portraits` | read | `986ce9a330b95ad4320e169942a159ab0d2810ef4a18b2dc89683ba485232a2d` | `b6d6425f6ae7d9964beae5320ea55cdb20678edec8963a9e8336ad773546168c` |
| `list_mcp_jobs` | read | `675587a6402a36e25a4eb60be4bc7b7c4c0ce577fe82de47a019a277f521325a` | `0e61c6b871ee78427a6c9c44605dd5ab078c5eb5c53f901d849a0422d0307a29` |
| `list_mcp_operations` | read | `32eb8d4d3095139db68a0838da529856a367ca4fbb89b6ec8c3399c4470b4b7d` | `2d484d7f29e384777385433331141484f9cd72bbb1059125b0e05d44e3a9e581` |
| `list_notebook` | read | `cdeb1c0d8ae7d77ccadf5dc3e9148912b9d2a08e35d50e27929d7e46c2431819` | `ac8bc0eefb9ac09014984a3e74e81ecab9f29af2eab0c7529544994afede31c6` |
| `list_notebook_categories` | read | `675587a6402a36e25a4eb60be4bc7b7c4c0ce577fe82de47a019a277f521325a` | `32e1660ef759c1e27d474611979f2d2bc07305d9b420330ba33c31c5d008c5e4` |
| `list_practice_questions` | read | `2966f276024203caa67f68250725c88ffe7149ad5050a5e22291aeb66df4fe94` | `2217055bc68ea5fcb718c2f7afbe7f756f82434ef794e8c2813dac3cbe029796` |
| `list_practice_sessions` | read | `f1e37a892f6f80569c88796ab67f2fd47a02ab9034593eab0851d5cdba685838` | `cfd65035d177ac83764cedf5531584e9e4c358ea1d890106c2eb6113ca038b8a` |
| `list_preparation_tasks` | read | `3bba05f9dcb66a3e9b1621b0490f2b40c35967ca5df829f9fceaf147f27773f2` | `b0b61ed46f58d0eba194a99db858befbfe052c77e3294ece466258de40a6045d` |
| `list_project_materials` | read | `3bba05f9dcb66a3e9b1621b0490f2b40c35967ca5df829f9fceaf147f27773f2` | `dba6a7887c79c6bab6381d9c1be3d68b9c174ffe4d884da7276bb70fb157ee39` |
| `list_project_summary_history` | read | `f161e6a852cf29ab12a9ed3b3ad5028d51d1e3779320174be3e86e632f6fae05` | `d2280869966297394be018c0185479e672e58f72e0e6788f46c8f5eafed80ba1` |
| `list_projects` | read | `042d41ff76ac5a2b2c4ec0c8f0e27e223cc2c36d38677ae77a31c4103b1a575b` | `8735afbef12f22a25fbc747d67e551f359241b9bb7c25e7c5491557dfce0ef05` |
| `list_repository_evidence_history` | read | `f161e6a852cf29ab12a9ed3b3ad5028d51d1e3779320174be3e86e632f6fae05` | `f3e702c1225acf7404d057676ab92fd9c16cc76a7bfed3b620492953e2533e80` |
| `list_resume_diagnoses` | read | `6d5baf6ce18db594170585bc403266e6328821309ebf72d527d6a4358c5d6b47` | `c8150af954ebc4f449b7a893fc6b586ec9a34b026e8435446c731895d882a2f6` |
| `list_resume_versions` | read | `3bba05f9dcb66a3e9b1621b0490f2b40c35967ca5df829f9fceaf147f27773f2` | `fb00f6dee4ec3dbe5094ea6fa1087fb17235cd62ac1bc907871ffe9a69d830e4` |
| `list_resumes` | read | `042d41ff76ac5a2b2c4ec0c8f0e27e223cc2c36d38677ae77a31c4103b1a575b` | `49c986f09ea87e8fdf7a7448f691000123250f9f17b5e0dca22fd7cb30024002` |
| `list_review_cards` | read | `01e32413274e80a349b79d58bf9b8bbfb94556c64570a168b092791f3ce95a47` | `38b47c46da63e372e1c6531ce6459d778e800bdeb8ac7c84a3d29f9a069b0f2c` |
| `maintain_mcp_state` | write | `f52204dcae3055803afef9714bbc9730a869db36ffc2fb69b8c59438a20d05cd` | `61004e401a35aa9e6087d8a3f16259b9989b1617b64f2d815860c4483d1f931b` |
| `move_notebook_entry` | write | `54272ba12316b5bdb24c378e90815f2b0dfb502e3b60aed222c79405d0f4887c` | `b577c7e23babd11c60ae8b9d22ef3d210604ccd3ee6841d5583f280d575d63b6` |
| `preview_application_edit` | read | `faa58dc1e3478f5420e72c10dcbd12d0c09473319aea31834e20cfd457e155ed` | `2dbd07db50c3b6667cdb8f63700d72ec82e8641584fd2b35cb7d7a77dd5abf73` |
| `preview_application_rebase` | read | `b6cab2a61cb84a71aa500c92b7ab21769b6dcb48923b655f402cc2caf5e5e163` | `71fc6b5107892c0de644d72981ae225b2925ab7c35922b822ec2ae0342b39f8b` |
| `preview_bank_import` | read | `f82f5b0a7bed0fbcb8fdf7f36d4dd549585b331769693256d42d3ce2ff63c390` | `ea78d562563735ef2e757669d3bf42b2260e4220bab047d593b2a58f8009650d` |
| `preview_diagnosis_adoption` | read | `cb39096c8e0b19f2db0994389ae22c6613b2a14668fe91c576eb9ea680ba2fc5` | `ea78d562563735ef2e757669d3bf42b2260e4220bab047d593b2a58f8009650d` |
| `preview_file_import` | read | `53c3ee0eecc7df0487407271c390bb89b2ccda6bf8b31d557692a06090cb8ab0` | `ea78d562563735ef2e757669d3bf42b2260e4220bab047d593b2a58f8009650d` |
| `preview_intro_edit` | read | `cab09c8b573394a6b90db0a8e43e795ddce28987d827eae46b2232d1f054c00d` | `26814891826eb9f7bed61ff24d02da11a44eba0bf535edbe0eb1be7347713aa6` |
| `preview_mcp_cache_cleanup` | read | `f52204dcae3055803afef9714bbc9730a869db36ffc2fb69b8c59438a20d05cd` | `989322fb7563423d8e4b70ddd06c5294633557a8afb89856c3419bc5fcf1b0b2` |
| `preview_project_material_edit` | read | `2f3814566ddaa5f4555a286bb5db27f6b2859214ef035488ea437b7b207d2069` | `ea78d562563735ef2e757669d3bf42b2260e4220bab047d593b2a58f8009650d` |
| `preview_project_summary` | read | `14ff04b90815a280f521fa24bd99a3ecd428dc4815c8ccb9d27aff3372259dc5` | `ea78d562563735ef2e757669d3bf42b2260e4220bab047d593b2a58f8009650d` |
| `preview_repository_evidence_update` | read | `9be59ccf81c5a657493156d7bef4971e08a7d49915e9071f1ae6817f00d79f7e` | `ea78d562563735ef2e757669d3bf42b2260e4220bab047d593b2a58f8009650d` |
| `preview_resume_draft_edit` | read | `3814103c4f700d8dab0c9ab98d6c40c8eba606cbc10ded793031dbb7b187a54f` | `ea78d562563735ef2e757669d3bf42b2260e4220bab047d593b2a58f8009650d` |
| `preview_resume_draft_rebase` | read | `0780346c4c04966d69db2e8fd8b4282f563b0856921c9820c59ad25255955d70` | `71fc6b5107892c0de644d72981ae225b2925ab7c35922b822ec2ae0342b39f8b` |
| `preview_resume_layout` | read | `5aa3ba2be397f8dbe701adcb1a93c8c8fa0ef86c48052eefc6b572930824998a` | `ea78d562563735ef2e757669d3bf42b2260e4220bab047d593b2a58f8009650d` |
| `preview_resume_template` | read | `1a37b1280372fcf054633ea8da08b78c6743f997e71aad6fb096f1fdf38938f7` | `ea78d562563735ef2e757669d3bf42b2260e4220bab047d593b2a58f8009650d` |
| `preview_resume_version_branch` | read | `2dc34eca497e4bbbd67655d67ea618ee3d68caf073f4b4e91b62ec0abf791c25` | `ea78d562563735ef2e757669d3bf42b2260e4220bab047d593b2a58f8009650d` |
| `publish_resume_version` | write | `a1f5a7fccfca9d3c1cb1c0af3b1e817e5efdd60a3f6eb185ee2f3a024e4dec83` | `b577c7e23babd11c60ae8b9d22ef3d210604ccd3ee6841d5583f280d575d63b6` |
| `read_export_artifact` | read | `e954595cfddde34d6d3246a02a156a84e430608422e6c8070d5bd57c87c03c46` | `bb7ee3f019a4de918e1f1c657dc39a753004e89a347fc45e2e3c86c391fcf92b` |
| `read_record_section` | read | `8bfbbce98a4e5c688e55495583929c6cc6272b4be294bb03f2f8cb081325060f` | `003917e6d2dcf16e7d27ca461fdb9dc68cf96f998c0f10cbedcd5b7f4b1bd80e` |
| `rename_notebook_category` | write | `9059ea5b88dd81e845101c36134b5659562381d52faa69cbab1b1f473876869e` | `b577c7e23babd11c60ae8b9d22ef3d210604ccd3ee6841d5583f280d575d63b6` |
| `reschedule_application_interview` | write | `f61760b8d067f6a94b6a5c2df3cb65c34b8eea308ab55ba0e892368c91731512` | `b577c7e23babd11c60ae8b9d22ef3d210604ccd3ee6841d5583f280d575d63b6` |
| `save_ai_draft` | write | `88256764353e62ee6baabdf1c4387862f6d490038ae2051351a159897221c9ca` | `d2de81b11023e39e8c52bdaf31aab6d78a30e3449b02bb3646d4264f08230bd0` |
| `save_application_edit` | write | `032fdc28385c0c23cc293ea793db69bde02c88b74bd3b9631861c10c8df51158` | `4ad631bf629579e2f3b339380708041b09404fa216ebbb41fd9c63e147d85aef` |
| `save_application_interview_questions` | write | `5159f7719b8bc196c1b58bc31dc45f2c303fe2ca3d59b2cb0b59875b017d7747` | `b577c7e23babd11c60ae8b9d22ef3d210604ccd3ee6841d5583f280d575d63b6` |
| `save_bank_import` | write | `08e6973c4243849d0efc60f787fa43a3f3d447ece4488255939aba1a28dd180f` | `ec9766e07a554c06c9541cbed4acfbbb205bfcee6cec748e83b699499cb27685` |
| `save_career_result` | write | `00f11b3e455b00f5764cb4cbe3a1e22cd827e68c734ffc95f77d6a68e72311b9` | `b577c7e23babd11c60ae8b9d22ef3d210604ccd3ee6841d5583f280d575d63b6` |
| `save_diagnosis_adoption` | write | `cb0fbb0027d66b2b86c7995cc35bbd1e69e20af4a15eb1b420933bb745dfc447` | `b577c7e23babd11c60ae8b9d22ef3d210604ccd3ee6841d5583f280d575d63b6` |
| `save_file_import` | write | `f4144b49825b3341790ddf3a1a4c51868eaf20fb0dea2aecc496d4820e51a01e` | `b577c7e23babd11c60ae8b9d22ef3d210604ccd3ee6841d5583f280d575d63b6` |
| `save_generated_intro` | write | `e48f2549e09a9c333f72a3b2b81dcb4d78772fad40ec2900b9d4f6e809842ad1` | `b577c7e23babd11c60ae8b9d22ef3d210604ccd3ee6841d5583f280d575d63b6` |
| `save_generated_practice` | write | `4af38c1cbadd23ea65cf7c437617f09e9904d8a5e097d70888381c36de5ce330` | `b577c7e23babd11c60ae8b9d22ef3d210604ccd3ee6841d5583f280d575d63b6` |
| `save_interview_series_result` | write | `22293d37993ddbb80a9d56318dba85d08208440f5192821cc863acbe279f24c4` | `b577c7e23babd11c60ae8b9d22ef3d210604ccd3ee6841d5583f280d575d63b6` |
| `save_interview_training_result` | write | `96476780fbacfae722037da2ed9a2838eea6412b7a2bba1903f42c92ba357c86` | `b577c7e23babd11c60ae8b9d22ef3d210604ccd3ee6841d5583f280d575d63b6` |
| `save_intro_comments` | write | `1d579da548713c97364374a7438bd840f95593d9ad4d024f140bb4a2fda1ad4b` | `b577c7e23babd11c60ae8b9d22ef3d210604ccd3ee6841d5583f280d575d63b6` |
| `save_intro_edit` | write | `98f8058508fe98ae6947ca4dd3f8260439506a3e36dfc1a6bd3e48aa6969f177` | `b577c7e23babd11c60ae8b9d22ef3d210604ccd3ee6841d5583f280d575d63b6` |
| `save_jargon_result` | write | `34dbc8f1e56a59ed462e2d858535ebcad19d7aa722af5cb14d3042cd2bd0df3d` | `b577c7e23babd11c60ae8b9d22ef3d210604ccd3ee6841d5583f280d575d63b6` |
| `save_notebook_note` | write | `43ddcb76bfdab9cebde49c21a5fb83fa8565f14b5988d26ba0f9880704911faa` | `b577c7e23babd11c60ae8b9d22ef3d210604ccd3ee6841d5583f280d575d63b6` |
| `save_project_material_edit` | write | `bc9ce39d30904dc35bdf66ace00732c78dcfab957ddf92ceeb08a6c0ddb83a08` | `b577c7e23babd11c60ae8b9d22ef3d210604ccd3ee6841d5583f280d575d63b6` |
| `save_project_summary` | write | `2be03347738f9985bf4063b05e21da9f72f9d8d8ed62f8e419258f626c0dd093` | `b577c7e23babd11c60ae8b9d22ef3d210604ccd3ee6841d5583f280d575d63b6` |
| `save_repository_evidence` | write | `fe339b839179aa6c67afab9b809a32154515864559e080f5bb392e3d0562079b` | `2f7afc608dc63c954dcc37205808f0d3f40fc5610aa9a9b0074220bec02a806c` |
| `save_repository_evidence_update` | write | `fce7172482bf4fa9bfd392d88a94a9e8b494465400c14ebe33ba425f581d31d4` | `74c5b0549eccd64372b91e4c747adaf9d49a13bc72595bce3a51456e04f73e9f` |
| `save_resume_draft_edit` | write | `4ad3221fdf614afaab31d68fee755850d12091811ef84c9fe742faab13967ed1` | `b577c7e23babd11c60ae8b9d22ef3d210604ccd3ee6841d5583f280d575d63b6` |
| `save_resume_layout` | write | `12577b832597091bc5dd8c81b802862616488961393fd0c95649b3b3c39a2755` | `b577c7e23babd11c60ae8b9d22ef3d210604ccd3ee6841d5583f280d575d63b6` |
| `save_resume_template` | write | `7126abfac3b60dee1fcc4fada1e7432286263efa69e7485eda84f369c589fb07` | `b577c7e23babd11c60ae8b9d22ef3d210604ccd3ee6841d5583f280d575d63b6` |
| `schedule_application_interview` | write | `a913b547eae88a2052d19aec27db8b8f460df491687ad6ad4bc108e3dc0d63e1` | `b577c7e23babd11c60ae8b9d22ef3d210604ccd3ee6841d5583f280d575d63b6` |
| `search_records` | read | `ef164517f0ddd245afd6ba5db76425decd9b11892eb3674715f15de48069ac12` | `297f0ad8e3dcca6b640092253e1a1afaab09133d0e48b4887c8d194ddd80e468` |
| `search_records_page` | read | `dde34c5bc725be66d52da45c9e4ef180969c9172d6e84a3931175dd0c99e364e` | `c35ed77a86ba84c0624f01da7f8aa5d62798514509b817c28465481535398587` |
| `set_preparation_resource` | write | `202bd6fd9a04acc53198f737f6b40a337e8d85668b00fd2390f7e0c28ad0e1b8` | `4594a3134e51171466549196b566f48f96349659b55b91c31ef7acbeb58a21ab` |
| `set_preparation_step` | write | `b8ce46cf476846ee89f397403e1903e69bbcbfc8422237d162289e4c0420ed1c` | `96e362f0c408c0d2466f2771ec475c590255b37877295f658f4dbceeaf6dc9bd` |
| `set_resume_avatar` | write | `7f05a4c614f8a5d8d37f49f54c8e006be973c7d2c318aa62383cae61653f5988` | `b577c7e23babd11c60ae8b9d22ef3d210604ccd3ee6841d5583f280d575d63b6` |
| `start_mcp_job` | write | `358bcf6b0e282fdcfcae26bce9fe6164ebff473806ccd2387bff677657f18c96` | `3ae4a1504bfec48054ef8e421745ebf98b8bbcaaf42a8393262c11b398276612` |
| `start_mock_interview` | write | `80a159c63cb9350001e84c8b6b6e98b3f63261aa003feb6f9880feeec0b6bf58` | `b577c7e23babd11c60ae8b9d22ef3d210604ccd3ee6841d5583f280d575d63b6` |
| `submit_ai_draft` | write | `62e66db96e3181388f772ede78b5a937b25b04b5976d4b21566fb3297548977d` | `54ec419f0cfed7d6af83d9139557eef9f63413edfef01443206c9cdef58c45ec` |
| `submit_file_import` | write | `8e211d2add6bcb0f3d343c4810db530e9194e47e62efdd899d38c0b25613cac5` | `85489b7aff57739160f9815a126b5fdb4321fc4ad0c825e2b6ce53f30be97516` |
| `submit_practice_answer` | write | `748a213e1f28f33a176c109324ac891d248a90d492c824962bff69dc8388c4c7` | `b577c7e23babd11c60ae8b9d22ef3d210604ccd3ee6841d5583f280d575d63b6` |
| `submit_review` | write | `2e2128966cb1d5ad93af1acf5dca00e60bda287afbb25aef39faeb91d745dfc8` | `b7758578c0d371df14a473d01e68efe2b55392e5e231eec194651866bef08878` |
| `update_application` | write | `1ca27170b1b3899b8f0d4c4c2a262036539e601d766e7fd6e0adc71b46996374` | `49e406a4e2b457dfbecb1154ca263d842e73e310d4df8cd8f9107956d9d9055a` |
| `update_application_interview` | write | `2aced0df4c6b59ced9f2add596c8507f300f4fde59fe55b03f40c974ee371142` | `b577c7e23babd11c60ae8b9d22ef3d210604ccd3ee6841d5583f280d575d63b6` |
| `update_preparation_task` | write | `7cd1408487a2b84cf20d2a9468b66f0fa635a77319cbab5e519a4fa9d40d74f5` | `b577c7e23babd11c60ae8b9d22ef3d210604ccd3ee6841d5583f280d575d63b6` |

| 工作流 | 必要能力 |
|---|---|
| `intro-generation` | `get_resume`、`get_intro_generation_context`、`save_generated_intro`、`get_intro`、`read_record_section` |
| `project-summary` | `get_project`、`list_project_materials`、`get_project_summary_context`、`preview_project_summary`、`save_project_summary`、`list_project_summary_history` |
| `practice-generation` | `get_practice_question`、`list_practice_sessions`、`get_practice_generation_context`、`save_generated_practice`、`list_practice_questions`、`get_practice_answer_context`、`read_record_section`、`submit_practice_answer` |
| `review-practice` | `list_review_cards`、`get_review_card`、`read_record_section`、`submit_review`、`get_review_submission` |
| `series-create` | `get_resume`、`get_interview_series_context`、`save_interview_series_result`、`get_interview_series`、`read_record_section` |
| `series-round` | `get_interview`、`get_resume`、`get_interview_series`、`get_series_interview_state`、`read_record_section`、`answer_series_interview`、`finish_series_interview` |
| `series-advance` | `get_interview`、`get_resume`、`get_interview_series`、`get_interview_series_context`、`save_interview_series_result` |
| `series-finalize` | `get_interview`、`get_resume`、`get_interview_series`、`get_interview_series_context`、`save_interview_series_result` |
| `salary-training` | `get_career_workflow_context`、`save_career_result`、`get_career_record` |
| `application-conflict-resolution` | `get_application`、`preview_application_rebase`、`preview_application_edit`、`save_application_edit` |
| `resume-conflict-resolution` | `get_resume`、`get_resume_draft_context`、`preview_resume_draft_rebase`、`preview_resume_draft_edit`、`save_resume_draft_edit` |
| `file-upload` | `begin_mcp_upload`、`get_mcp_upload`、`append_mcp_upload`、`complete_mcp_upload` |
| `file-import` | `get_mcp_upload`、`get_file_extraction`、`extract_uploaded_file`、`start_mcp_job`、`get_mcp_job`、`get_mcp_job_result`、`get_file_import_context`、`submit_file_import`、`preview_file_import`、`save_file_import` |
| `template-authoring` | `get_resume`、`get_resume_template_context`、`create_resume_template`、`preview_resume_template`、`save_resume_template` |
| `avatar-update` | `get_resume`、`get_mcp_upload`、`get_resume_avatar_context`、`set_resume_avatar` |
| `repository-incremental` | `get_project`、`list_project_materials`、`get_repository_capture`、`get_repository_catalog`、`get_project_material_context`、`capture_project_repository`、`get_repository_evidence_diff`、`preview_repository_evidence_update`、`save_repository_evidence_update`、`list_repository_evidence_history` |
| `filtered-search` | `list_applications`、`get_application`、`search_records_page` |
| `cache-maintenance` | `preview_mcp_cache_cleanup`、`cleanup_mcp_cache` |
| `project-file-import` | `get_mcp_upload`、`get_file_extraction`、`extract_uploaded_file`、`get_project`、`list_project_materials`、`get_project_material_context`、`start_mcp_job`、`get_mcp_job`、`get_mcp_job_result`、`get_file_import_context`、`submit_file_import`、`preview_file_import`、`save_file_import` |
| `resume-delivery` | `get_resume`、`get_resume_diagnosis`、`list_resume_versions`、`get_diagnosis_adoption_context`、`preview_diagnosis_adoption`、`save_diagnosis_adoption`、`get_resume_version_context`、`publish_resume_version`、`get_resume_export_context`、`export_resume`、`read_export_artifact`、`create_application` |
| `resume-layout` | `get_resume`、`get_resume_layout_context`、`preview_resume_layout`、`save_resume_layout` |
| `resume-version-branch` | `get_resume`、`list_resume_versions`、`compare_resume_versions`、`get_resume_version_context`、`preview_resume_version_branch`、`branch_resume_version` |
| `bank-import` | `list_bank_entries`、`preview_bank_import`、`save_bank_import`、`get_bank_import_result` |
| `notebook-organization` | `list_notebook_categories`、`get_notebook_entry`、`get_notebook_organization_context`、`create_notebook_category`、`rename_notebook_category`、`move_notebook_entry` |
| `project-material-edit` | `get_project`、`list_project_materials`、`get_project_material_context`、`preview_project_material_edit`、`save_project_material_edit` |
| `repository-evidence` | `get_project`、`list_project_materials`、`get_repository_catalog`、`get_project_material_context`、`capture_project_repository`、`get_repository_capture`、`save_repository_evidence`、`get_project_summary_context`、`preview_project_summary`、`save_project_summary` |
| `jargon-decoding` | `get_jargon_generation_context`、`save_jargon_result`、`get_career_record` |
| `portfolio-export` | `get_resume`、`get_project`、`get_portfolio_sources`、`get_portfolio_context`、`export_portfolio`、`read_export_artifact` |

工作流完整绑定契约 SHA-256：`ecda8146ea464445c4e85d38760ea7bf2f890b4db2c1ea3973a66b6d50822f85`。

| 预设 | 工具数 |
|---|---|
| readonly | 102 |
| preparation | 110 |
| collaboration | 166 |
| training | 63 |
| authoring | 101 |
