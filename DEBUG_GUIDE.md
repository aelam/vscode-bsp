# 🚀 如何启动BSP扩展调试

## 方法1：使用F5快捷键（推荐）

1. **确保你在VSCode中打开了这个项目文件夹**
2. **按 `F5` 键**
3. **选择 "Run Extension (No Build)"** 配置（避免任务问题）
4. **新的VSCode窗口将打开**，已加载BSP扩展

## 方法2：使用调试面板

1. **打开左侧调试面板** (Ctrl+Shift+D)
2. **在下拉菜单中选择 "Run Extension (No Build)"**
3. **点击绿色播放按钮**
4. **新窗口将启动**

## 方法3：使用命令面板

1. **打开命令面板** (`Cmd+Shift+P`)
2. **输入 "Debug: Select and Start Debugging"**
3. **选择 "Run Extension (No Build)"**

## ⚡ 如果遇到任务错误

如果还是遇到任务错误，可以：

### 手动编译然后运行
```bash
npm run compile
```
然后使用 "Run Extension (No Build)" 配置

### 或者修复任务配置
在命令面板中运行：
1. `Tasks: Configure Task`
2. 选择 `npm: compile`

## ✅ 成功标志

新窗口打开后，你应该看到：

- **左侧资源管理器** 中出现 "Build Targets" 面板
- **3个模拟构建目标**：
  - 📦 Library Target
  - ▶️ Application Target  
  - 🧪 Test Target
- **右键菜单** 中有编译、运行、调试选项
- **命令面板** 中有BSP相关命令

## 🔧 调试技巧

### 查看扩展日志
在新窗口中：
1. `Help > Toggle Developer Tools`
2. 查看 Console 标签页
3. 扩展启动时会显示 "BSP extension is now active"

### 实时修改代码
1. 在原窗口修改TypeScript代码
2. 运行 `npm run compile`
3. 在新窗口中按 `Ctrl+R` 重新加载扩展

## 🎯 快速验证功能

在新窗口中试试：
1. **展开 Build Targets 面板**
2. **右键点击 Application Target → Run Target**
3. **应该看到 "Run completed successfully" 通知**

这证明扩展完全正常工作！
