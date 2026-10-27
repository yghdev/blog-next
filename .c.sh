#!/usr/bin/env bash
cd /mnt/e/agentWork/server-management/blog-next
git add -A
git commit -F /mnt/e/agentWork/server-management/blog-next/.msg.txt 2>&1 | tail -4
echo '=== log ==='
git log --oneline -3
echo '=== status ==='
git status --porcelain
