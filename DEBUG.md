# BSP调试功能说明

## 概述

BSP扩展现在支持通过Build Server Protocol进行调试。这允许你直接从VSCode调试由BSP服务器管理的构建目标。

## 支持的调试模式

### 1. 启动调试 (Launch Debug)
- 启动程序并开始调试会话
- 适用于可执行的构建目标

### 2. 附加调试 (Attach Debug)  
- 连接到已运行的调试服务器
- 支持TCP连接和Unix socket

## 使用方法

### 通过树视图调试

1. 在"Build Targets"视图中找到你要调试的目标
2. 右键点击支持调试的目标（显示为🐛图标）
3. 选择"Debug Target"

### 通过命令面板调试

1. 打开命令面板 (`Cmd+Shift+P`)
2. 运行"BSP: Debug Target"命令
3. 选择要调试的构建目标

### 通过launch.json配置

创建或编辑`.vscode/launch.json`文件：

```json
{
    "version": "0.2.0",
    "configurations": [
        {
            "type": "bsp-debug",
            "request": "launch",
            "name": "BSP Debug",
            "program": "${workspaceFolder}/path/to/your/target",
            "stopOnEntry": true,
            "args": [],
            "cwd": "${workspaceFolder}",
            "environment": []
        },
        {
            "type": "bsp-debug", 
            "request": "attach",
            "name": "BSP Attach",
            "connect": {
                "host": "localhost",
                "port": 5005
            }
        }
    ]
}
```

## BSP服务器要求

要使用调试功能，你的BSP服务器必须：

1. **支持调试能力**：在`BuildServerCapabilities`中报告`debugProvider`
2. **实现调试请求**：响应`debugSession/start`请求
3. **返回调试地址**：提供DAP (Debug Adapter Protocol) 服务器的连接信息

### 调试地址格式

BSP服务器应该返回以下格式之一的调试地址：

- **TCP连接**: `tcp://hostname:port`
- **Unix Socket**: `unix:///path/to/socket`

## 支持的语言

目前支持以下语言的断点和调试：
- Scala
- Java  
- Kotlin

## 调试会话流程

1. **启动调试**: VSCode发送`debugSession/start`请求到BSP服务器
2. **获取地址**: BSP服务器返回调试服务器地址
3. **建立连接**: VSCode连接到Debug Adapter Protocol服务器
4. **开始调试**: 使用标准的VSCode调试功能

## 故障排除

### 调试会话无法启动

1. **检查构建目标能力**：确保目标支持调试（`canDebug: true`）
2. **验证BSP服务器**：确认BSP服务器实现了调试功能
3. **检查网络连接**：验证调试地址是否可访问
4. **查看日志**：检查VSCode开发者控制台的错误信息

### 断点不工作

1. **源码映射**：确保BSP服务器提供正确的源文件映射
2. **编译信息**：验证代码是用调试信息编译的
3. **路径匹配**：确保源文件路径在调试器中正确匹配

### 调试器连接超时

1. **检查端口**：确保指定的端口没有被防火墙阻止
2. **服务器状态**：验证调试服务器已正确启动
3. **网络配置**：检查主机名和端口配置

## 示例配置

### Bazel + Scala

```json
{
    "type": "bsp-debug",
    "request": "launch", 
    "name": "Debug Scala App",
    "program": "//src/main/scala:my-app",
    "stopOnEntry": false,
    "args": ["--config", "debug"]
}
```

### sbt项目

```json
{
    "type": "bsp-debug",
    "request": "attach",
    "name": "Attach to sbt",
    "connect": {
        "host": "localhost",
        "port": 5005
    }
}
```

## 高级功能

### 环境变量
可以在调试配置中设置环境变量：

```json
{
    "type": "bsp-debug",
    "request": "launch",
    "name": "Debug with Env",
    "program": "//my:target",
    "environment": [
        {
            "name": "DEBUG_LEVEL",
            "value": "TRACE"
        }
    ]
}
```

### 工作目录
指定调试会话的工作目录：

```json
{
    "type": "bsp-debug",
    "request": "launch", 
    "name": "Debug with CWD",
    "program": "//my:target",
    "cwd": "${workspaceFolder}/sub-project"
}
```

## 注意事项

1. **性能**: 调试可能会显著降低程序执行速度
2. **资源**: 调试会话会消耗额外的内存和CPU资源
3. **并发**: 同时只能运行一个调试会话
4. **兼容性**: 确保BSP服务器和调试器版本兼容
