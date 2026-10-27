#!/usr/bin/env bash
cd /mnt/e/agentWork/server-management/blog-next
echo '=== 全量测试 ==='
npm test 2>&1 | grep -E '# (tests|pass|fail)' | tail -3
echo '=== 提交 ==='
git add -A
git commit -m "fix(admin): 存储配置加常驻反馈，图库支持登记七牛已有对象

两个问题都来自上一版：

1. 保存后没有可信的反馈。原来只 setMsg 一句话又立刻 router.refresh()，
   用户看到的是页面闪一下；状态徽章只写"已启用"，不说明存了什么。
   现在结果条常驻（带时间戳、可手动关闭），徽章直接写空间名与 CDN 域名，
   保存成功后提示下一步该做什么。

2. 图库看不到七牛里的图。原因是那些对象是历史客户端传的，从未经过
   media 表 —— 图库读的是表，自然看不见。新增「登记七牛对象」：
   扫描空间、把库里没有的对象 INSERT 进 media（只登记不动对象），
   之后就能在媒体库里浏览、复制、删除。" 2>&1 | tail -3
git log --oneline -2
