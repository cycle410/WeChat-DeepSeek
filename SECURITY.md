# 安全说明（SECURITY）

本项目会在本地保存两类凭据：**微信机器人登录 token** 和 **大模型 API Key**。
下面说明它们怎么存、哪些绝对不能进 Git、以及出事之后怎么处理。

---

## 一、凭据存放在哪

| 文件 | 内容 | 存储方式 |
|---|---|---|
| `.config/config.json` | API Key、模型、baseUrl | `_encKey` 字段，AES-256-CBC 加密 |
| `.config/token.json` | 微信 iLink 登录 token、Bot ID、账号 ID | `_enc` 字段，AES-256-CBC 加密（v0.4+） |
| `.config/history/*.json` | 每用户的对话历史（**明文**） | 仅本地，需自行注意 |

加密密钥由「主机名 + 用户目录 + 用户名」派生，**换机器后解不开**——
这是有意为之：拷走 `.config` 到别的电脑也读不出明文，代价是换机要重新扫码 / 重填 Key。

`.config/` 目录权限被设为 `700`，其中的文件为 `600`。

---

## 二、绝对不能进 Git 的东西

```
.config/          ← 微信 token、API Key、聊天历史
__pycache__/      ← Python 字节码缓存
node_modules/
.env
*.log
```

`.gitignore` 已包含以上条目。**提交前用这条命令自检**：

```bash
git status --short          # 看有没有 .config 相关文件
git ls-files | grep -E '\.config|__pycache__|\.env'   # 应该没有输出
```

有输出就别提交，先 `git rm --cached`。

---

## 三、万一已经提交了怎么办

删掉当前文件**没有用**，历史里还在，任何人 checkout 旧提交都能看到。必须重写历史：

```bash
# 1. 从索引移除（保留本地文件）
git rm -r --cached .config __pycache__ 2>/dev/null

# 2. 重写全部历史，彻底删除这两个路径
FILTER_BRANCH_SQUELCH_WARNING=1 git filter-branch --force \
  --index-filter "git rm -r --cached --ignore-unmatch .config __pycache__" \
  --prune-empty --tag-name-filter cat -- --all

# 3. 清掉备份引用并 gc，否则旧对象还在
rm -rf .git/refs/original
git reflog expire --expire=now --all
git gc --prune=now

# 4. 强制推送
git push --force --all
git push --force --tags

# 5. 验证：应该没有任何输出
git rev-list --objects --all | grep -E '\.config|__pycache__'
```

> 重写历史会改变所有提交的 SHA，其他人（或服务器上的 clone）必须重新拉取。
> 仓库很小的情况下，**删库重建**往往比重写更省事。

---

## 四、泄露之后必须做的两件事

1. **作废旧 token**：重新扫码登录一次机器人，旧 token 立即失效
2. **轮换 API Key**：到模型服务商后台吊销并新建，然后重新配置

只删文件、不换凭据 = 没有止血。

---

## 五、运行时注意

- 日志里打印 Key 一律走 `maskKey()`，只显示首尾几位
- 用户消息写日志前会去掉换行，防止伪造日志行
- 建议把机器人限制在**私有微信群 / 只加自己**，避免陌生人触发大量模型调用
- 每用户限流：同人 3 秒间隔、每分钟最多 10 条（`lib/bot.mjs`）

---

## 六、报告问题

发现安全问题请开 issue 或私信作者，**不要在 issue 里贴真实 token / Key**。
