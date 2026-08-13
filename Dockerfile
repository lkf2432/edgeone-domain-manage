FROM python:3.12-slim

WORKDIR /app

# 安装依赖（利用缓存层）
COPY requirements.txt .
RUN pip install --no-cache-dir -i https://pypi.tuna.tsinghua.edu.cn/simple -r requirements.txt

# 复制项目文件
COPY app.py edgeone_client.py settings.py logger_setup.py ddns_scheduler.py ip_detector.py notifier.py ./
COPY templates/ ./templates/
COPY static/ ./static/

# 运行时数据目录（settings.json、ddns_config.json、logs 持久化到 /app/data）
RUN mkdir -p /app/data /app/logs

# 环境变量
ENV APP_PORT=8196
ENV PYTHONUNBUFFERED=1
ENV DATA_DIR=/app/data

EXPOSE 8196

# 监听全网段 IPv4 (0.0.0.0) 的 8196 端口
CMD ["gunicorn", "--bind", "0.0.0.0:8196", "--workers", "2", "--access-logfile", "-", "--error-logfile", "-", "app:app"]
