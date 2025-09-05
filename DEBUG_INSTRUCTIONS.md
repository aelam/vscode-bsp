# 🐛 BSP扩展调试指南

## 调试方式总览

### 1. 🔧 调试扩展代码（TypeScript）
### 2. 🌐 调试模拟BSP服务器
### 3. 🔍 调试BSP协议通信
### 4. 🎯 调试目标项目（通过BSP）

---

## 1. 🔧 调试扩展代码

### 快速开始
1. **在当前VSCode窗口中按 `F5`**
2. **选择 "Debug Extension"** 配置
3. **新窗口将打开，扩展已加载并可调试**

### 设置断点
在以下文件中设置断点：
- `src/extension.ts` - 扩展激活和命令处理
- `src/bspClient.ts` - BSP客户端通信
- `src/buildTargetProvider.ts` - UI树视图逻辑
- `src/debugProvider.ts` - 调试配置

### 调试技巧
```typescript
// 在代码中添加调试输出
console.log('Debug: BSP client connecting...');
console.error('Error:', error);

// 使用VSCode API显示调试信息
vscode.window.showInformationMessage('Debug: Extension activated');
```

### 常用调试点
- `activate()` 函数 - 扩展激活时
- `connect()` 方法 - BSP服务器连接时
- `getBuildTargets()` - 获取构建目标时
- `compile()`, `test()`, `run()` - 执行操作时

---

## 2. 🌐 调试模拟BSP服务器

### 独立调试服务器
1. **选择 "Debug Mock BSP Server"** 配置
2. **在 `mock-bsp-server.js` 中设置断点**
3. **服务器将在调试模式下启动**

### 手动测试服务器
```bash
# 启动服务器
node mock-bsp-server.js

# 在另一个终端发送测试请求
echo '{"jsonrpc":"2.0","id":1,"method":"build/initialize","params":{}}' | node mock-bsp-server.js
```

### 服务器调试点
- `handleMessage()` - 处理所有JSON-RPC消息
- `build/initialize` - 初始化处理
- `workspace/buildTargets` - 目标列表返回
- `buildTarget/compile` - 编译处理

---

## 3. 🔍 调试BSP协议通信

### 查看通信日志
在新VSCode窗口中：
1. **`Help > Toggle Developer Tools`**
2. **查看 Console 标签页**
3. **执行BSP操作，观察消息流**

### 典型通信流程
```
1. build/initialize    → 服务器初始化
2. build/initialized   → 初始化确认
3. workspace/buildTargets → 获取构建目标
4. buildTarget/compile → 编译目标
5. build/shutdown      → 关闭连接
```

### 添加协议调试
在 `bspClient.ts` 中添加：
```typescript
// 在发送请求前记录
console.log('Sending BSP request:', method, params);

// 在接收响应后记录
console.log('Received BSP response:', result);
```

---

## 4. 🎯 调试目标项目

### 使用BSP调试功能
1. **在Build Targets面板中右键目标**
2. **选择 "Debug Target"**
3. **配置调试参数**

### 调试配置示例
```json
{
    "type": "bsp-debug",
    "request": "attach",
    "name": "Debug Scala App",
    "connect": {
        "host": "localhost",
        "port": 5005
    }
}
```

---

## 🛠️ 常用调试命令

### VSCode命令面板
- `Developer: Reload Window` - 重新加载扩展
- `Developer: Show Running Extensions` - 查看扩展状态
- `BSP: Activate BSP Extension` - 手动激活
- `BSP: Refresh Build Targets` - 刷新目标

### 终端调试命令
```bash
# 编译并监听更改
npm run watch

# 手动编译
npm run compile

# 测试模拟服务器
echo '{"jsonrpc":"2.0","id":1,"method":"workspace/buildTargets"}' | node mock-bsp-server.js
```

---

## 🔧 调试配置文件

### .vscode/launch.json
- **Debug Extension** - 调试扩展主逻辑
- **Run Extension** - 运行扩展不调试
- **Debug Mock BSP Server** - 调试模拟服务器
- **Extension Tests** - 运行测试

### tsconfig.json 调试设置
```json
{
  "compilerOptions": {
    "sourceMap": true,    // 启用源映射
    "inlineSourceMap": false,
    "inlineSources": false
  }
}
```

---

## 📋 调试检查清单

### 扩展不启动
- [ ] 检查编译是否成功：`npm run compile`
- [ ] 检查 `out/` 目录是否有最新文件
- [ ] 查看开发者工具Console的错误信息
- [ ] 确认 `.bsp` 目录存在

### Build Targets不显示
- [ ] 执行 `BSP: Activate BSP Extension`
- [ ] 检查BSP服务器连接状态
- [ ] 验证 `mock-bsp-server.js` 可运行
- [ ] 查看 `workspace/buildTargets` 响应

### 编译/运行失败
- [ ] 检查目标是否支持该操作
- [ ] 查看BSP服务器日志
- [ ] 验证JSON-RPC通信
- [ ] 检查错误处理逻辑

---

## 🚀 高级调试技巧

### 1. 实时修改调试
```bash
# 启动watch模式
npm run watch
```
修改TypeScript文件后自动重新编译，在新窗口按 `Ctrl+R` 重新加载。

### 2. 网络调试
使用Wireshark或tcpdump监听localhost上的BSP通信。

### 3. 内存调试
在开发者工具的Memory标签页监控内存使用。

### 4. 性能调试
在开发者工具的Performance标签页分析性能瓶颈。

---

## 🎯 调试最佳实践

1. **逐步调试** - 从简单的激活开始
2. **日志充分** - 在关键点添加console.log
3. **隔离问题** - 分别测试扩展和BSP服务器
4. **文档记录** - 记录调试过程和解决方案

现在可以开始调试了！选择适合的调试配置并按F5启动。
