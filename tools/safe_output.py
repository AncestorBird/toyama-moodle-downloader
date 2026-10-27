"""File operations anchored to open directories, without following symlinks.

POSIX uses dir_fd/O_NOFOLLOW. Windows holds every parent directory open without
FILE_SHARE_DELETE, rejecting reparse points (including junctions).
"""

from contextlib import contextmanager, ExitStack
import errno
import os
from pathlib import Path
import secrets
import stat


if os.name == "nt":
    import ctypes
    from ctypes import wintypes
    import msvcrt

    _kernel = ctypes.WinDLL("kernel32", use_last_error=True)
    _kernel.CreateFileW.argtypes = [wintypes.LPCWSTR, wintypes.DWORD, wintypes.DWORD,
                                   wintypes.LPVOID, wintypes.DWORD, wintypes.DWORD, wintypes.HANDLE]
    _kernel.CreateFileW.restype = wintypes.HANDLE
    _kernel.GetFileInformationByHandleEx.argtypes = [wintypes.HANDLE, ctypes.c_int,
                                                   wintypes.LPVOID, wintypes.DWORD]
    _kernel.GetFileInformationByHandleEx.restype = wintypes.BOOL
    _kernel.CloseHandle.argtypes = [wintypes.HANDLE]
    _kernel.CloseHandle.restype = wintypes.BOOL

    def _windows_handle(path, directory):
        handle = _kernel.CreateFileW(str(path), 0x80 if directory else 0x80000000,
                                     3, None, 3, 0x02200000, None)
        if handle == wintypes.HANDLE(-1).value:
            raise ctypes.WinError(ctypes.get_last_error())
        try:
            class Attributes(ctypes.Structure):
                _fields_ = [("attributes", wintypes.DWORD), ("tag", wintypes.DWORD)]
            info = Attributes()
            if not _kernel.GetFileInformationByHandleEx(handle, 9, ctypes.byref(info), ctypes.sizeof(info)):
                raise ctypes.WinError(ctypes.get_last_error())
            if info.attributes & 0x400 or bool(info.attributes & 0x10) != directory:
                raise OSError(errno.ELOOP, "Reparse points and unexpected file types are refused")
            return handle
        except BaseException:
            _kernel.CloseHandle(handle)
            raise


class Directory:
    def __init__(self, path, *, create=False):
        self.path = Path(os.path.abspath(path))
        self.stack = ExitStack()
        self.fd = None
        try:
            if os.name == "nt":
                current = Path(self.path.anchor)
                self._lock(current)
                for part in self.path.parts[1:]:
                    current /= part
                    if create:
                        current.mkdir(mode=0o700, exist_ok=True)
                    self._lock(current)
            else:
                flags = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW
                self.fd = os.open(self.path.anchor, flags)
                self.stack.callback(os.close, self.fd)
                for part in self.path.parts[1:]:
                    if create:
                        try:
                            os.mkdir(part, mode=0o700, dir_fd=self.fd)
                        except FileExistsError:
                            pass
                    self.fd = os.open(part, flags, dir_fd=self.fd)
                    self.stack.callback(os.close, self.fd)
        except BaseException:
            self.stack.close()
            raise

    def _lock(self, path):
        handle = _windows_handle(path, True)
        self.stack.callback(_kernel.CloseHandle, handle)

    def __enter__(self):
        return self

    def __exit__(self, *args):
        self.stack.close()

    def _name(self, name):
        if not name or name in (".", "..") or any(c in name for c in "/\\:\x00"):
            raise ValueError("Expected one safe path component")
        return name

    def open_read(self, name):
        name = self._name(name)
        if os.name == "nt":
            handle = _windows_handle(self.path / name, False)
            try:
                fd = msvcrt.open_osfhandle(handle, os.O_RDONLY | os.O_BINARY)
            except BaseException:
                _kernel.CloseHandle(handle)
                raise
        else:
            fd = os.open(name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=self.fd)
        try:
            if not stat.S_ISREG(os.fstat(fd).st_mode):
                raise OSError(errno.EINVAL, "Expected a regular file")
            return os.fdopen(fd, "rb")
        except BaseException:
            os.close(fd)
            raise

    def is_current(self):
        if os.name == "nt":
            return True  # All parent directories remain locked against renames.
        try:
            with Directory(self.path) as current:
                a, b = os.fstat(self.fd), os.fstat(current.fd)
                return (a.st_dev, a.st_ino) == (b.st_dev, b.st_ino)
        except OSError:
            return False

    @contextmanager
    def temporary(self):
        name = ".download-" + secrets.token_hex(16)
        flags = os.O_CREAT | os.O_EXCL | os.O_RDWR | getattr(os, "O_BINARY", 0)
        fd = (os.open(self.path / name, flags, 0o600) if os.name == "nt"
              else os.open(name, flags | os.O_NOFOLLOW, 0o600, dir_fd=self.fd))
        try:
            with os.fdopen(fd, "w+b") as stream:
                yield name, stream
        finally:
            try:
                if os.name == "nt":
                    (self.path / name).unlink()
                else:
                    os.unlink(name, dir_fd=self.fd)
            except FileNotFoundError:
                pass

    def link(self, source, target):
        source, target = self._name(source), self._name(target)
        if os.name == "nt":
            os.link(self.path / source, self.path / target, follow_symlinks=False)
        else:
            os.link(source, target, src_dir_fd=self.fd, dst_dir_fd=self.fd, follow_symlinks=False)

    def replace(self, source, target):
        source, target = self._name(source), self._name(target)
        if os.name == "nt":
            os.replace(self.path / source, self.path / target)
        else:
            os.replace(source, target, src_dir_fd=self.fd, dst_dir_fd=self.fd)
