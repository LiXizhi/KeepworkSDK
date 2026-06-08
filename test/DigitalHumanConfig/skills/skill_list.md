# SilverMind Skills
- 每个Skill都是一个动态加载的互动小游戏
- 数字人根据上下文会先询问用户是否要开启某个互动, 不要自动开启
- 用户同意后，数字人需要调用`read_file({filePath: "path", startLine: 1, endLine: -1, allowScript: true})`读取对应路径下的SKILL.md并自动运行里面的脚本。

## Skill List

memory-practice:
- name: 记忆训练
- desc: 帮助老人回忆过去2周中发生的事情，提升老人的记忆力，预防思维退化。
- read_file({filePath: "skills/memory-practice/SKILL.md", startLine: 1, endLine: -1, allowScript: true})

find-word:
- name: 找单词
- desc: 通过找单词小游戏，从老人近期经历中提取关键词藏入字母网格，锻炼记忆与注意力。
- read_file({filePath: "skills/findWords/SKILL.md", startLine: 1, endLine: -1, allowScript: true})

life-quiz:
- name: 时光机问答
- desc: 围绕老人长期记忆（童年、求学、工作、家人、家乡）出 4 选 1 选择题，借题打开话匣子重温人生故事。
- read_file({filePath: "skills/lifeQuiz/SKILL.md", startLine: 1, endLine: -1, allowScript: true})

who-am-i:
- name: 猜猜是谁
- desc: AI 给出 3 条逐渐变明显的线索，让老人猜出 memory.md 中真实出现过的一位家人/老友，激活人物记忆与情感联结。
- read_file({filePath: "skills/whoAmI/SKILL.md", startLine: 1, endLine: -1, allowScript: true})

true-or-false:
- name: 真真假假
- desc: AI 说一句关于老人自己的事，老人判断是真的还是 AI 瞎编的（在真事实上轻改一处细节）。锻炼现实辨识与记忆。
- read_file({filePath: "skills/trueOrFalse/SKILL.md", startLine: 1, endLine: -1, allowScript: true})

hometown-tour:
- name: 家乡寻宝
- desc: 围绕老人家乡的地名、小吃、方言、风俗出 4 选 1 选择题，让老人当晚辈的"家乡导游"，重温故土记忆。
- read_file({filePath: "skills/hometownTour/SKILL.md", startLine: 1, endLine: -1, allowScript: true})

story-fill-blank:
- name: 故事填空
- desc: AI 把老人讲过的真实故事简短复述一遍，挖掉一个关键细节（人名/地名/食物/年份）让老人填，锻炼叙事性记忆。
- read_file({filePath: "skills/storyFillBlank/SKILL.md", startLine: 1, endLine: -1, allowScript: true})

family-match:
- name: 亲情连连看
- desc: 把家人 / 老友与他们的拿手菜、兴趣、一起去过的地方两两配对，激活关联性记忆，强化人物-事件绑定。
- read_file({filePath: "skills/familyMatch/SKILL.md", startLine: 1, endLine: -1, allowScript: true})

life-timeline:
- name: 人生时间线
- desc: 把老人人生中的 4-6 件真实大事打乱呈现，老人按从早到晚的顺序点选。锻炼时序记忆与人生叙事感。
- read_file({filePath: "skills/lifeTimeline/SKILL.md", startLine: 1, endLine: -1, allowScript: true})

old-song-lyrics:
- name: 老歌接词
- desc: 挑老人年轻时代的经典老歌，展示一句歌词但挖掉最后几个字，让老人接词。借音乐唤起情景记忆。
- read_file({filePath: "skills/oldSongLyrics/SKILL.md", startLine: 1, endLine: -1, allowScript: true})

read-sentence:
- name: 外语跟读
- desc: 按用户选择的第二语言和水平展示短句，让用户跟读、模仿语气并获得轻松反馈，持续记录学习偏好与发音重点。
- read_file({filePath: "skills/readSentence/SKILL.md", startLine: 1, endLine: -1, allowScript: true})


xiangqi:
- name: 象棋对弈
- desc: 陪老人下一盘中国象棋，用户执红棋先手，AI执黑棋。数字人在旁边观棋、评论、鼓励，让下棋更有趣。
- read_file({filePath: "skills/xiangqi/SKILL.md", startLine: 1, endLine: -1, allowScript: true})


## Skill激活规则
每天完成测评时，建议加载memory-practice做记忆力训练

