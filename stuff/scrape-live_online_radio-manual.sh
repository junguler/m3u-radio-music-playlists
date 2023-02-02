#!/bin/bash

# scrape the links
curl https://liveonlineradio.net/countries | htmlq -a href a | grep "/category/" | cut -c11- > list.txt 

# get the links for the webpages
for i in "" page/{2..200} ; do for j in $(cat list.txt) ; do curl -s https://liveonlineradio.net/category/$j/$i | htmlq -a href a | grep "https://liveonlineradio.net/" | grep -v "page" | sed 's/\;//g' | awk '!seen[$0]++' | sed '/^$/d' >> $j.txt ; echo -e "\n$j - $i - done\n" ; done ; done

# remove list.txt and other empty text files
rm list.txt ; find . -type f -empty -delete

# remove duplicate entries
for i in *.txt ; do cat $i | awk '!seen[$0]++' > A-$i ; done

# scrape the links from each text file to a m3u output
for i in A-*.txt ; do for j in $(cat $i) ; do curl -s $j | htmlq audio | grep -oP 'src="\K[^"]+' | sed 's/\;//g' | sed '/^$/d' >> A$i ; echo -e "\n$i - $j - done\n" ; done ; done

# convert links to m3u streams
for i in AA-*.txt ; do for j in $(cat $i) ; do grep -v "https://liveonlineradio.net/file/OffAir.mp3" $i | sed 's/?type=.mp3//g' | sed "s/^/#EXTINF:-1\n/" | sed '1s/^/#EXTM3U\n/' > $i.m3u ; done ; done

# remove AA- and double extensions in streams
for i in *.m3u ; do mv "$i" "`echo $i | sed -e 's/AA-//' -e 's/.txt//'`" ; done

# move stream to git folder
mv *.m3u c:/git/m3u-radio-music-playlists/live_online_radio/

# add, commit and push
git -C c:/git/m3u-radio-music-playlists/ add .
git -C c:/git/m3u-radio-music-playlists/ commit -m "`date +'%b/%d - %I:%M %p'`"
git -C c:/git/m3u-radio-music-playlists/ push
