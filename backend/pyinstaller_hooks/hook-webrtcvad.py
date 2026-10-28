# Overrides the contrib hook: it copies metadata for "webrtcvad", but we install the
# "webrtcvad-wheels" distribution (same module), so ship that metadata instead.
from PyInstaller.utils.hooks import copy_metadata

datas = copy_metadata("webrtcvad-wheels")
