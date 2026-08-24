# @dsh-plugin/proxy

DSH 组合包插件：在 harness 进程内为**全局 fetch** 设置 undici `ProxyAgent`，让所有
HTTP 请求（LLM 调用、web 工具、其他插件）走本地代理出口。

## 解决什么问题

Node 的全局 fetch（undici）既不读 Windows 系统代理、也不读 `HTTPS_PROXY` 环境变量，
所以 dsh 进程直连出口 IP。当出口 IP 所在地区被服务商限制时（例如 OpenRouter 对
Claude 系模型按地区封锁），请求返回 403 "This model is not available in your region."，
而 harness 会把 401/403 统一归类为 `AUTH`，界面上显示成误导性的 **"API key is
invalid"**——key 本身其实是有效的。

安装本插件后，全局 fetch 经由本地代理出网，地区判定以代理出口为准，问题即消失。

## 代理地址怎么定（自动跟随，可覆盖）

解析优先级（取第一个命中）：

1. **组合行 `config.proxyUrl`** —— 手动固定地址，最优先。需要固定时在
   `cordis.patch.yml` 取消 `config.proxyUrl` 的注释并填 URL。
2. **Windows 系统代理（自动）** —— 读注册表 `ProxyEnable`/`ProxyServer`，跟随
   Clash 等工具当前设置的端口。**每 15 秒重查一次**：运行中改了代理端口/开关，
   无需重启 dsh 也会自动切换。这就是"地址会变化也不用管"的默认行为。
3. **`HTTPS_PROXY` / `https_proxy` 环境变量**。
4. 都没有 → 不设代理，保持直连（日志打印提示）。

> 只支持 Windows（依赖 `reg.exe` 读注册表）；其他平台请用 `config.proxyUrl`
> 或 `HTTPS_PROXY` 显式指定。

## 原理

undici 的全局 dispatcher 存放在 `Symbol.for('undici.globalDispatcher.2')` 共享符号上，
`setGlobalDispatcher(new ProxyAgent(url))` 对进程内任何 undici 实例都生效，Node 全局
fetch（OpenAI SDK / pi-ai / 其他插件）随后全部走该代理。

## 安装
1、下载本项目
在项目下运行
```sh
pnpm install 
```
安装依赖

2、添加插件
到dsh源码目录运行
```sh
pnpm dsh plugin --profile web add dsh-proxy-plugin目录的路径
```

3、重启dsh
```sh
pnpm dsh web
```


## 验证

```sh
pnpm dsh --profile web --dump-config   # 应出现 "# == @dsh-plugin/proxy" 层
# 启动后日志出现 "[dsh-proxy] global fetch dispatcher -> <地址>"
```

## 卸载

```sh
pnpm dsh plugin --profile web remove @dsh-plugin/proxy
pnpm dsh web   # 重启后全局代理即移除
```
