#!/bin/bash

# scrape the links
curl https://liveonlineradio.net/countries | htmlq -a href a | grep "/category/" | cut -c11- > list.txt 
curl https://liveonlineradio.net/ | htmlq -a href a | grep "genres" | cut -c9- > genres.txt

# get the links for the webpages
for i in "" page/{2..200} ; do for j in $(cat list.txt) ; do curl -s https://liveonlineradio.net/category/$j/$i | htmlq -a href a | grep "https://liveonlineradio.net/" | grep -v "page\|category" | sed 's/\;//g' | awk '!seen[$0]++' | sed '/^$/d' | cut -c29- >> A-$j.txt ; echo -e "$j - $i" ; done ; done
for i in "" page/{2..200} ; do for j in $(cat genres.txt) ; do curl -s https://liveonlineradio.net/genres/$j/$i | ./htmlq -a href a | grep "https://liveonlineradio.net/" | grep -v "page\|genres" | sed 's/\;//g' | awk '!seen[$0]++' | sed '/^$/d' | cut -c29- >> A-$j.txt ; echo -e "$j - $i" ; done ; done

# remove list.txt and other empty text files
rm list.txt genres.txt ; find . -type f -empty -delete

# remove duplicate entries
for i in *.txt ; do cat $i | awk '!seen[$0]++' > A-$i ; done

# scrape the links from each text file to a m3u output
#for i in A-*.txt ; do for j in $(cat $i) ; do curl -s $j | htmlq audio | grep -oP 'src="\K[^"]+' | sed 's/\;//g' | sed '/^$/d' >> A$i ; echo -e "\n$i - $j - done\n" ; done ; done
for i in A-*.txt ; do for j in $(cat $i) ; do curl -s https://liveonlineradio.net/$j > mep1 ; cat mep1 | htmlq --text h1 | sed '/^$/d' | ( echo "#EXTINF:-1 , " && cat) | paste -d "" -s | awk 'length>15' >> A$i ; cat mep1 | htmlq audio | grep -oP 'src="\K[^"]+' | sed 's/\;//g' | sed '/^$/d' >> A$i ; echo -e "$i - $j" ; done ; done
#for i in A-*.txt ; do for j in $(cat $i) ; do curl -s https://liveonlineradio.net/$j > mep1 ; { echo "#EXTINF:-1 , " & cat mep1 | htmlq --text h1 | sed '/^$/d' ; } | paste -d "" -s | awk 'length>15' >> A$i ; cat mep1 | htmlq audio | grep -oP 'src="\K[^"]+' | sed 's/\;//g' | sed '/^$/d' >> A$i ; echo -e "$i - $j" ; done ; done

# remove streams that don't have a title
for i in AA-*.txt ; do cat $i | grep -B1 "http" | sed '/^$/d' > A$i ; done

# remove streams that are currently offline
for i in AAA-*.txt ; do cat $i | grep -B1 -v "OffAir" | sed '/^$/d' > A$i ; done
for i in AAAA-*.txt ; do cat $i | grep -v "\-\-" | sed '/^$/d' > A$i ; done

# convert links to m3u streams
for i in AAAAA-*.txt ; do sed '1s/^/#EXTM3U\n/' $i > $i.m3u ; done

# remove AAAAA- and double extensions in streams
for i in *.m3u ; do mv "$i" "`echo $i | sed -e 's/AAAAA-//' -e 's/.txt//'`" ; done
