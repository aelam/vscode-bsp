# 🔧 BSP扩展UI故障排除指南

## 问题：看不到Build Targets UI

### 📋 检查清单

#### 1. 确认扩展已激活
在新的VSCode窗口中：
- 打开命令面板 (`Cmd+Shift+P`)
- 搜索 "BSP"
- 应该能看到BSP相关的命令

#### 2. 检查扩展激活消息
- 打开开发者工具：`Help > Toggle Developer Tools`
- 查看Console标签页
- 应该看到：`BSP extension is now active`

#### 3. 确认工作区已打开
- 确保在新VSCode窗口中打开了包含`.bsp`目录的文件夹
- 在资源管理器中应该能看到项目文件

### 🚀 解决方案

#### 方案1：手动激活（推荐）
1. 在新VSCode窗口中打开命令面板 (`Cmd+Shift+P`)
2. 输入并执行：**"BSP: Activate BSP Extension"**
3. 应该看到成功连接的消息

#### 方案2：强制刷新视图
1. 命令面板 → **"View: Reset Views"**
2. 命令面板 → **"BSP: Show Build Targets"**

#### 方案3：重新加载扩展
1. 在新VSCode窗口中按 `Ctrl+R` (macOS: `Cmd+R`)
2. 等待扩展重新加载

#### 方案4：检查工作区
1. 在新VSCode窗口中：`File > Open Folder`
2. 选择包含BSP扩展的项目文件夹：`/Users/wang.lun/Work/vscode-bsp`
3. 确保能看到`.bsp`文件夹

### 🔍 调试步骤

#### 检查扩展状态
1. 命令面板 → **"Extensions: Show Running Extensions"**
2. 查找 "BSP Client" 扩展
3. 检查是否显示为 "Activated"

#### 查看详细日志
在开发者控制台中查找：
```
BSP extension is now active
BSP Extension activated!
Initializing BSP extension...
BSP context enabled
BSP tree view registered
Attempting to connect to BSP server...
BSP server connected, refreshing targets...
BSP: Connected to server successfully!
```

#### 手动显示面板
如果扩展已激活但UI不显示：
1. 命令面板 → **"View: Open View"**
2. 选择 **"Build Targets"**

### ⚡ 快速修复命令

在新VSCode窗口的命令面板中依次执行：

1. **`BSP: Activate BSP Extension`**
2. **`BSP: Show Build Targets`**
3. **`BSP: Refresh Build Targets`**

### 🎯 成功标志

修复成功后你应该看到：

- ✅ 左侧资源管理器中出现 **"Build Targets"** 面板
- ✅ 面板中显示3个模拟目标：
  - 📦 **Library Target**
  - ▶️ **Application Target**
  - 🧪 **Test Target**
- ✅ 状态栏显示：**"BSP: Connected to server successfully!"**

### 🆘 如果仍然无法解决

1. **关闭新VSCode窗口**
2. **在原窗口重新按F5启动**
3. **在新窗口中立即执行：`BSP: Activate BSP Extension`**

或者尝试：
1. **停止调试会话**
2. **运行 `npm run compile`**
3. **重新按F5启动**

### 📞 确认连接

执行这些命令验证功能：
- `BSP: Show Build Targets` - 应该聚焦到面板
- `BSP: Refresh Build Targets` - 应该刷新目标列表
- 右键任意目标 → 应该看到操作菜单
