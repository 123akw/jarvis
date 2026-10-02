"""SQLite 小工具：账户库与租户库共用的连接类型。"""
from __future__ import annotations

import os
import sqlite3
from pathlib import Path


class ClosingConnection(sqlite3.Connection):
    """with 块结束即关闭连接。

    sqlite3.Connection 自带的 with 只负责提交/回滚、并不关闭连接；本项目所有读写都是
    「with self._connect() as c: ...」的一次性用法，于是每次操作都留下一个等 GC 回收的连接
    （Python 3.13+ 每个都报 ResourceWarning: unclosed database，异常路径上的引用环还会把
    文件句柄拖到下一次 GC）。"""

    def __exit__(self, exc_type, exc, tb):
        try:
            return super().__exit__(exc_type, exc, tb)
        finally:
            self.close()


def file_identity(path: Path) -> tuple[str, int, int] | None:
    """库文件的身份（路径 + inode）：文件被删除重建后视为新库，迁移缓存随之失效。"""
    try:
        stat = os.stat(path)
    except OSError:
        return None
    return str(path), stat.st_ino, stat.st_dev
