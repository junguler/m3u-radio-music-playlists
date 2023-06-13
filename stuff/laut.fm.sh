#!/bin/bash

# find genres 
curl -s https://laut.fm/fm-api/genres | jq -r '.[].name' | sed 's/ /%20/g' | sort > genres.txt

# find every page title within each genres
for i in $(cat genres.txt) ; do curl -s https://laut.fm/fm-api/stations/genre/$i?offset=0&limit=10000 | jq -r '.items[].name' >> A-$i.txt ; echo -e $i ; done

# make sure text files are linux compatible
for i in A-*.txt ; do sed -i 's/\r$//' $i ; done

# convert page titles to streams, no need to put any further load on the website
for i in A-*.txt ; do for j in $(cat $i) ; do echo "#EXTINF:-1 , $(echo $j | sed -e 's/-/ /g' -e 's/_/ /g')\nhttp://$j.stream.laut.fm/$j" >> A$i ; done ; done

# convert links to m3u streams
for i in AA-*.txt ; do sed '1s/^/#EXTM3U\n/' $i > $i.m3u ; done

# remove AA- and double extensions in streams
for i in *.m3u ; do mv "$i" "`echo $i | sed -e 's/AA-//' -e 's/.txt//'`" ; done

# replace %20 in file names with _
for i in *.m3u ; do mv -- "$i" "$(printf '%s\n' "$i" | sed 's/%20/_/')" ; done
