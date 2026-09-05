/**
 * LabelPlus Photoshop 自动嵌字/标号导入脚本
 * 兼容: Photoshop CS6 / CC 2014 ~ 2026+ (Windows & macOS)
 * 支持格式: 翻译_0.txt / translations.txt (UTF-8)
 * 
 * 使用方法:
 * 1. 将解压出来的漫画图片与「翻译_0.txt」放在同一个文件夹（例如 images/ 目录）
 * 2. 打开 Photoshop，将本脚本文件 (.jsx) 直接拖入 Photoshop 窗口中（或通过 文件 -> 脚本 -> 浏览 运行）
 * 3. 脚本会自动加载当前目录的「翻译_0.txt」，并为每张图片自动生成文字图层，存入 output/ 文件夹
 */

#target photoshop

(function main() {
    app.displayDialogs = DialogModes.NO;

    // 1. 选择翻译文本文件
    var txtFile = File.openDialog("请选择「翻译_0.txt」或「translations.txt」", "文本文件:*.txt;所有文件:*.*");
    if (!txtFile) return;

    var baseFolder = txtFile.parent;
    txtFile.encoding = "UTF-8";
    if (!txtFile.open("r")) {
        alert("无法打开文件: " + txtFile.fsName);
        return;
    }

    var content = txtFile.read();
    txtFile.close();

    // 移除 UTF-8 BOM 头
    if (content.charCodeAt(0) === 0xFEFF) {
        content = content.substring(1);
    }

    // 2. 解析 LabelPlus 格式（完美兼容官方 >>>>>>>>[文件]<<<<<<<< 与 [Page_xxx] 双格式）
    var lines = content.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");
    var pages = [];
    var currentPage = null;
    var currentLabel = null;

    var fileRe = /^>{4,}\[(.+)\]<{4,}\s*$/;
    var labelRe = /^-{4,}\[(\d+)\]-{4,}\[([0-9.]+),([0-9.]+),(\d+)\]\s*$/;

    for (var i = 0; i < lines.length; i++) {
        var line = lines[i].replace(/^\s+|\s+$/g, "");
        if (!line) continue;

        // 官方格式：>>>>>>>>[001.jpg]<<<<<<<<
        var officialFileMatch = line.match(fileRe);
        if (officialFileMatch) {
            currentPage = {
                index: pages.length + 1,
                filename: officialFileMatch[1],
                labels: []
            };
            pages.push(currentPage);
            currentLabel = null;
            continue;
        }

        // 官方标号：----------------[1]----------------[0.123,0.456,1]
        var officialLabelMatch = line.match(labelRe);
        if (currentPage && officialLabelMatch) {
            currentLabel = {
                groupId: parseInt(officialLabelMatch[4], 10) || 1,
                x: parseFloat(officialLabelMatch[2]),
                y: parseFloat(officialLabelMatch[3]),
                text: ""
            };
            currentPage.labels.push(currentLabel);
            continue;
        }

        // 备用格式：[Page_001]
        var pageMatch = line.match(/^\[Page_(\d+)\]$/i);
        if (pageMatch) {
            currentPage = {
                index: parseInt(pageMatch[1], 10),
                filename: "",
                labels: []
            };
            pages.push(currentPage);
            currentLabel = null;
            continue;
        }

        if (currentPage && !currentPage.filename) {
            currentPage.filename = line;
            continue;
        }

        var labelMatch = line.match(/^\[(\d+)\]$/);
        if (currentPage && labelMatch) {
            currentLabel = {
                groupId: parseInt(labelMatch[1], 10),
                x: 0,
                y: 0,
                text: ""
            };
            currentPage.labels.push(currentLabel);
            continue;
        }

        if (currentLabel && currentLabel.x === 0 && currentLabel.y === 0 && line.indexOf(",") !== -1) {
            var coords = line.split(",");
            if (coords.length >= 2) {
                currentLabel.x = parseFloat(coords[0]);
                currentLabel.y = parseFloat(coords[1]);
                continue;
            }
        }

        if (currentLabel) {
            if (currentLabel.text) {
                currentLabel.text += "\n" + lines[i];
            } else {
                currentLabel.text = lines[i];
            }
        }
    }

    if (pages.length === 0) {
        alert("未在文本中识别到有效的 LabelPlus 页面或标号数据！");
        return;
    }

    // 3. 输出目录
    var outputFolder = new Folder(baseFolder.fsName + "/output");
    if (!outputFolder.exists) {
        outputFolder.create();
    }

    var successCount = 0;
    var failList = [];

    // 4. 遍历处理每张图片
    for (var p = 0; p < pages.length; p++) {
        var page = pages[p];
        if (!page.filename) continue;

        var imgFile = new File(baseFolder.fsName + "/" + page.filename);
        if (!imgFile.exists) {
            // 尝试同名不同扩展名匹配
            var stem = page.filename.replace(/\.[^.]+$/, "");
            var candidates = [stem + ".jpg", stem + ".png", stem + ".jpeg", stem + ".webp"];
            for (var c = 0; c < candidates.length; c++) {
                var testF = new File(baseFolder.fsName + "/" + candidates[c]);
                if (testF.exists) {
                    imgFile = testF;
                    break;
                }
            }
        }

        if (!imgFile.exists) {
            failList.push(page.filename + " (文件未在同目录下找到)");
            continue;
        }

        try {
            var doc = app.open(imgFile);
            var docW = doc.width.as("px");
            var docH = doc.height.as("px");

            // 倒序添加文字图层，保证阅读顺序自然从上到下
            for (var l = page.labels.length - 1; l >= 0; l--) {
                var label = page.labels[l];
                if (!label.text) continue;

                var textLayer = doc.artLayers.add();
                textLayer.kind = LayerKind.TEXT;
                textLayer.name = label.text.replace(/\n/g, " ").substring(0, 15) || ("图层 " + (l + 1));

                var textItem = textLayer.textItem;
                textItem.contents = label.text;

                // 坐标换算：如果是归一化坐标(0~1)，则乘以宽高；否则视为绝对像素
                var posX = label.x;
                var posY = label.y;
                if (posX <= 1.0 && posY <= 1.0) {
                    posX = posX * docW;
                    posY = posY * docH;
                }

                textItem.position = [UnitValue(posX, "px"), UnitValue(posY, "px")];

                // 默认样式设置
                try {
                    // 自适应字号 (约图高的 3.2%)
                    textItem.size = UnitValue(Math.max(12, Math.round(docH * 0.032)), "px");
                    var textColor = new SolidColor();
                    textColor.rgb.red = 0;
                    textColor.rgb.green = 0;
                    textColor.rgb.blue = 0;
                    textItem.color = textColor;
                } catch (e) {}
            }

            // 保存为 PSD
            var psdSaveOptions = new PhotoshopSaveOptions();
            psdSaveOptions.layers = true;
            psdSaveOptions.embedColorProfile = true;

            var psdName = page.filename.replace(/\.[^.]+$/, "") + ".psd";
            var saveFile = new File(outputFolder.fsName + "/" + psdName);
            doc.saveAs(saveFile, psdSaveOptions, true, Extension.LOWERCASE);
            doc.close(SaveOptions.DONOTSAVECHANGES);

            successCount++;
        } catch (err) {
            failList.push(page.filename + " (" + err.message + ")");
        }
    }

    // 5. 提示完成
    var msg = "处理完成！\n成功生成 PSD: " + successCount + " 张\n保存位置: " + outputFolder.fsName;
    if (failList.length > 0) {
        msg += "\n\n存在无法匹配或失败的文件 (" + failList.length + " 个):\n" + failList.slice(0, 5).join("\n");
        if (failList.length > 5) msg += "\n...等";
    }
    alert(msg);
})();