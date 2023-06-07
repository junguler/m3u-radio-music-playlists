#!/bin/bash

# first step is to create the html files
# refer to this script
# https://github.com/junguler/m3u-radio-music-playlists/blob/main/stuff/m3u2webamp.sh

# create a directory named things and put the html files into it
# create a new github repo, clone it and cd into it and paste that things folder inside
# now cd into the things folder
cd things

# list every html file to a links.txt for README.MD creation
ls *.html > links.txt

# set the first character of each file at the top so we can use it as a header
gawk '{n=substr($1,0,1); print >> n".txt"}' links.txt

# remove this file and cd back and folder
rm links.txt ; cd ..

# create the links for our makrdown file
for i in things/*.txt ; do for j in $(cat $i) ; do echo "# $i \n[$(echo $j | sed 's/.html//g')](https://junguler.github.io/$(basename "$PWD")/things/$j) \n" >> things.md ; done ; done

# remove temp file, and extra stuff we don't need
rm things/*.txt 
cat things.md | awk '!seen[$0]++' | awk NF | sed -e 's/.txt//g' -e 's/# things\//# /g' | sed '0~1 a\\' > README.md
rm things.md