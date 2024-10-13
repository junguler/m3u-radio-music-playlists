#!/bin/bash

# find genres
curl -s http://directory.shoutcast.com/ | htmlq -a href a | grep "Genre" | sort | awk -F '=' '{print $2}' > genres.txt

# get id for every stream from it's json page
for i in $(cat genres.txt) ; do curl 'https://directory.shoutcast.com/Home/BrowseByGenre' -X POST -H 'Content-Type: application/x-www-form-urlencoded' --data-raw genrename=$i | jq -r '.[] | "\(.ID)"' > $i.txt ; done

# scarpe the streams from each .m3u playlist
for i in *.txt ; do for j in $(cat $i) ; do curl -s http://yp.shoutcast.com/sbin/tunein-station.m3u\?id\=$j | sed -n '2,3p' >> A-$i ; done ; done

# clean up stream titles
for i in A-*.txt ; do cat $i | sed 's/([^()]*)//g' | sed 's|, |,|g' > A$i ; done

# convert links to m3u streams
for i in AA-*.txt ; do sed '1s/^/#EXTM3U\n/' $i > $i.m3u ; done

# remove AA- and double extensions in streams
for i in *.m3u ; do mv "$i" "`echo $i | sed -e 's/AA-//' -e 's/.txt//'`" ; done

# change %20 and %26 in m3u files to underline and _n_
for i in *.m3u ; do mv $i $(echo $i | sed -e 's|%20||g' -e 's|%26|_n_|g') ; done