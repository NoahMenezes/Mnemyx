# Homebrew formula for Mnemyx (custom tap).
#
# Lives in a SEPARATE repo: github.com/NoahMenezes/homebrew-tap as
#   Formula/mnemyx.rb
# Users then run:  brew install NoahMenezes/tap/mnemyx
#
# After each `git tag vX.Y.Z` release, update `version`, the four CLI urls
# and the four server urls below, and fill every `sha256` from that
# release's SHA256SUMS.txt asset. (`brew bump-formula-pr` automates this.)
class Mnemyx < Formula
  desc "Local-first searchable memory of your shell history (MCP server)"
  homepage "https://github.com/NoahMenezes/Mnemyx"
  version "0.1.0"
  license "MIT"

  on_macos do
    on_arm do
      url "https://github.com/NoahMenezes/Mnemyx/releases/download/v0.1.0/mnemyx-darwin-arm64"
      sha256 "FILL_FROM_SHA256SUMS_TXT"
    end
    on_intel do
      url "https://github.com/NoahMenezes/Mnemyx/releases/download/v0.1.0/mnemyx-darwin-x64"
      sha256 "FILL_FROM_SHA256SUMS_TXT"
    end
  end
  on_linux do
    on_arm do
      url "https://github.com/NoahMenezes/Mnemyx/releases/download/v0.1.0/mnemyx-linux-arm64"
      sha256 "FILL_FROM_SHA256SUMS_TXT"
    end
    on_intel do
      url "https://github.com/NoahMenezes/Mnemyx/releases/download/v0.1.0/mnemyx-linux-x64"
      sha256 "FILL_FROM_SHA256SUMS_TXT"
    end
  end

  # The MCP stdio server binary clients spawn (ships alongside the CLI).
  resource "mnemyx-server" do
    on_macos do
      on_arm do
        url "https://github.com/NoahMenezes/Mnemyx/releases/download/v0.1.0/mnemyx-server-darwin-arm64"
        sha256 "FILL_FROM_SHA256SUMS_TXT"
      end
      on_intel do
        url "https://github.com/NoahMenezes/Mnemyx/releases/download/v0.1.0/mnemyx-server-darwin-x64"
        sha256 "FILL_FROM_SHA256SUMS_TXT"
      end
    end
    on_linux do
      on_arm do
        url "https://github.com/NoahMenezes/Mnemyx/releases/download/v0.1.0/mnemyx-server-linux-arm64"
        sha256 "FILL_FROM_SHA256SUMS_TXT"
      end
      on_intel do
        url "https://github.com/NoahMenezes/Mnemyx/releases/download/v0.1.0/mnemyx-server-linux-x64"
        sha256 "FILL_FROM_SHA256SUMS_TXT"
      end
    end
  end

  def install
    cli = Dir["mnemyx-*"].reject { |f| f.include?("server") }.first
    raise "mnemyx CLI binary missing from stage" if cli.nil?
    bin.install cli => "mnemyx"
    resource("mnemyx-server").stage do
      srv = Dir["mnemyx-server-*"].first
      raise "mnemyx-server binary missing from stage" if srv.nil?
      bin.install srv => "mnemyx-server"
    end
  end

  test do
    assert_match version.to_s, shell_output("#{bin}/mnemyx --version")
    require "open3"
    init = '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"test","version":"0"}}}'
    out, _err, _st = Open3.capture3("#{bin}/mnemyx-server", stdin_data: init)
    assert_match "serverInfo", out
  end
end
