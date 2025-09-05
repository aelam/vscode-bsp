# 测试BSP扩展UI

## 如何测试扩展

### 方法1：在VSCode中调试运行

1. 打开VSCode并加载这个项目
2. 按 `F5` 或使用调试菜单 "Run Extension"
3. 这会打开一个新的VSCode窗口，加载了你的扩展
4. 在新窗口中，你应该能看到：
   - 左侧资源管理器中出现"Build Targets"视图
   - 其中包含3个模拟的构建目标：
     - Library Target (库)
     - Application Target (应用程序)
     - Test Target (测试)

### 方法2：打包并安装扩展

1. 安装vsce工具：
   ```bash
   npm install -g vsce
   ```

2. 打包扩展：
   ```bash
   vsce package
   ```

3. 安装.vsix文件到VSCode

### 测试功能

#### 构建目标视图
- ✅ "Build Targets"面板应该显示在左侧资源管理器中
- ✅ 展开目标可以看到能力、依赖关系等信息
- ✅ 不同类型的目标有不同的图标：
  - 📦 Library Target (库图标)
  - ▶️ Application Target (播放图标)
  - 🧪 Test Target (烧杯图标)

#### 右键菜单
- ✅ 右键点击Library Target应该显示"Compile Target"选项
- ✅ 右键点击Application Target应该显示"Compile Target"和"Run Target"选项
- ✅ 右键点击Test Target应该显示"Compile Target"和"Test Target"选项

#### 命令面板
打开命令面板 (`Cmd+Shift+P`) 应该能找到：
- ✅ "BSP: Refresh Build Targets"
- ✅ "BSP: Show Build Targets"
- ✅ "BSP: Compile Target"
- ✅ "BSP: Test Target"
- ✅ "BSP: Run Target"
- ✅ "BSP: Debug Target"

#### 模拟服务器交互
当你执行编译等操作时：
- ✅ 状态栏应该显示任务开始/完成消息
- ✅ 控制台会显示与模拟BSP服务器的通信日志

## 故障排除

### 扩展未激活
- 确保项目根目录有`.bsp`文件夹
- 检查`.bsp/test.json`配置文件存在
- 查看VSCode开发者控制台的错误信息

### 没有构建目标显示
- 检查模拟BSP服务器是否能正常启动
- 确保`mock-bsp-server.js`文件有执行权限
- 查看BSP客户端连接日志

### 模拟服务器无法启动
- 确保Node.js已安装
- 检查`mock-bsp-server.js`文件路径正确
- 验证JSON-RPC通信是否正常

## 调试技巧

### 查看日志
1. 在扩展主机窗口中打开开发者工具：`Help > Toggle Developer Tools`
2. 查看控制台日志了解扩展行为
3. 检查网络标签页查看JSON-RPC通信

### 修改模拟数据
编辑`mock-bsp-server.js`文件可以：
- 添加更多模拟构建目标
- 修改目标能力和属性
- 模拟不同的响应和错误情况

### 实时修改
- 启用watch模式：`npm run watch`
- 修改TypeScript代码后自动重新编译
- 在扩展主机窗口中按`Ctrl+R`重新加载扩展

## 预期结果

如果一切正常，你应该能够：

1. ✅ 看到"Build Targets"视图在左侧面板
2. ✅ 展开目标查看详细信息
3. ✅ 使用右键菜单执行编译、测试、运行操作
4. ✅ 通过命令面板访问所有BSP命令
5. ✅ 看到任务进度和完成通知
6. ✅ 模拟调试会话启动（虽然不会真正连接到调试器）

这证明了扩展的UI和基本功能都能正常工作，可以与真实的BSP服务器集成使用。
