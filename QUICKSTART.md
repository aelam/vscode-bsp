# 快速开始指南

## 🚀 立即测试BSP扩展

### 1. 开发模式测试（推荐）

在当前VSCode窗口中：

1. **打开命令面板** (`Cmd+Shift+P`)
2. **运行 "Debug: Start Debugging"** 或按 `F5`
3. **选择 "Run Extension"** 配置
4. **新窗口将打开**，已加载BSP扩展

### 2. 在新窗口中验证功能

新的VSCode窗口中应该能看到：

#### ✅ Build Targets 视图
- 左侧资源管理器中出现 "Build Targets" 面板
- 显示3个模拟目标：
  - 📦 **Library Target** (库)
  - ▶️ **Application Target** (应用)  
  - 🧪 **Test Target** (测试)

#### ✅ 右键菜单功能
- 右键Library Target → "Compile Target"
- 右键Application Target → "Compile Target", "Run Target", "Debug Target"
- 右键Test Target → "Compile Target", "Test Target"

#### ✅ 命令面板命令
打开命令面板查找：
- "BSP: Refresh Build Targets"
- "BSP: Show Build Targets" 
- "BSP: Compile Target"
- "BSP: Test Target"
- "BSP: Run Target"
- "BSP: Debug Target"

### 3. 测试交互功能

试试这些操作：

1. **编译目标**：右键Library Target → Compile Target
   - 应该看到状态栏显示"Task started"和"Task finished"消息
   
2. **运行目标**：右键Application Target → Run Target
   - 应该显示"Run completed successfully"通知

3. **刷新视图**：点击Build Targets面板标题栏的刷新按钮

## 🐛 如果出现问题

### 扩展未激活
检查控制台输出：
- `Help > Toggle Developer Tools`
- 查看Console标签页的错误信息

### 无Build Targets视图
确认文件存在：
- `.bsp/test.json` ✅
- `mock-bsp-server.js` ✅  
- 两个文件都应该存在于项目根目录

### BSP服务器连接失败
在新窗口的控制台中查看错误：
```
BSP extension is now active
Failed to connect to BSP server: [错误信息]
```

## 📦 打包安装（可选）

如果想要永久安装扩展：

```bash
# 安装vsce工具
npm install -g @vscode/vsce

# 打包扩展
npm run package

# 安装扩展包
code --install-extension vscode-bsp-*.vsix
```

## ✨ 成功标志

如果看到以下内容，说明扩展完全正常：

- ✅ Build Targets视图正常显示
- ✅ 3个模拟目标都正确显示
- ✅ 右键菜单功能可用
- ✅ 命令面板命令可用
- ✅ 编译/运行操作有反馈消息
- ✅ 模拟BSP服务器正常通信

**🎉 恭喜！你的BSP扩展已经可以正常工作了！**

现在可以将真实的BSP服务器配置文件放到`.bsp/`目录下，扩展就能与真实的构建工具集成使用。
