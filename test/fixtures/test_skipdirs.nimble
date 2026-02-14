# Package
version       = "1.0.0"
author        = "test"
description   = "Test package with skipDirs"
license       = "MIT"

# Package name
name          = "test_skipdirs"

# Dependencies
requires "nim >= 1.6.0"

# Skip directories
skipDirs = @["tests", "docs", "examples"]