# 读取平板回传图像 · ComfyUI 节点

节点读取平板助手最近一次收到的合成图，也就是底图加标注。自动预览需要同机运行的 AI 创作平板助手 v1.1.0 或更新版。

## 安装

1. 从 [GitHub Releases](https://github.com/XinXinDaddy/ai-creative-tablet-assistant/releases/latest) 下载 ComfyUI 节点 ZIP，然后解压。
2. 将解压得到的 `ai_creative_tablet_assistant` 文件夹复制到 `ComfyUI/custom_nodes/`。安装后，Python 入口的路径应为 `ComfyUI/custom_nodes/ai_creative_tablet_assistant/__init__.py`，前端脚本位于该文件夹的 `web/live_preview.js`。
3. 重启 ComfyUI，刷新浏览器页面。在画布上搜索 **读取平板回传图像** 或 **Tablet Return Image**，添加节点。`port` 默认是 `3680`，应与平板助手实际端口一致。

## 自动预览

1. 在 Windows 本机启动平板助手，打开 PC 控制台 `http://localhost:3680/pc`，用平板扫描二维码完成配对。
2. 将含该节点的工作流保持在 ComfyUI 前台。平板画完后，点击 **同步到 PC 剪贴板** 回传，也可以使用平板的 **落笔自动同步**。
3. 回传图会直接更新到节点的预览区域。预览更新无需点击 **运行**。需要把最新的完整图像传给 **Save Image**、图生图等下游节点时，将 `IMAGE` 输出接到对应输入，再点击 **运行**。

如果预览为空，先确认平板已经回传过一张图，并检查平板助手是否在线、节点端口是否一致。
